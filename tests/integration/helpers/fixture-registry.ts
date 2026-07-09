import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { GenericContainer, Wait, type StartedNetwork } from "testcontainers";
import type { Devdb } from "./container.js";

// Task 15 (dynamic-pg-builds): the HERMETIC fixture registry. The suite must never pull the
// compute-node BUILD from Docker Hub — instead an in-network `registry:2` container (alias
// `pgregistry`) is seeded with an image assembled from the devdb container's OWN baked
// /usr/local/share/neon/pg_install/v17 (a real Neon-built postgres — same bits the daemon
// ships), plus a deliberately broken stub. The daemon under test gets
// DEVDB_PG_REGISTRY_BASE=http://pgregistry:5000 so its OCI client pulls from this fixture over
// the shared docker network. (Pulling `registry:2` itself from the Hub is test INFRA and
// explicitly allowed; only the compute-node BUILD must be hermetic.)

export interface FixtureRegistry {
  /** Base the DAEMON dials from inside the docker network (`http://pgregistry:5000`). */
  internalBase: string;
  /** Base the TEST dials from the host (mapped 5000) — used only for seeding. */
  externalBase: string;
  stop(): Promise<void>;
}

export async function startFixtureRegistry(net: StartedNetwork): Promise<FixtureRegistry> {
  const container = await new GenericContainer("registry:2")
    .withNetwork(net)
    .withNetworkAliases("pgregistry")
    .withExposedPorts(5000)
    .withWaitStrategy(Wait.forHttp("/v2/", 5000).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();
  return {
    internalBase: "http://pgregistry:5000",
    externalBase: `http://localhost:${container.getMappedPort(5000)}`,
    stop: async () => { await container.stop(); },
  };
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// Registry-v2 monolithic blob upload: POST an upload session, then PUT the bytes at the returned
// Location with `digest` appended. registry:2 answers the POST with a Location that already
// carries a `?_state=…` query — resolving it as a URL (relative Locations are legal per the
// distribution spec) and setting the digest via searchParams handles both `?` and `&` joining.
async function uploadBlob(
  externalBase: string, repository: string, bytes: Buffer,
): Promise<{ digest: string; size: number }> {
  const digest = sha256(bytes);
  const post = await fetch(`${externalBase}/v2/${repository}/blobs/uploads/`, { method: "POST" });
  const postBody = await post.text();
  if (post.status !== 202) {
    throw new Error(`blob upload POST for ${repository} -> ${post.status}: ${postBody}`);
  }
  const location = post.headers.get("location");
  if (!location) throw new Error(`blob upload POST for ${repository} returned no Location header`);
  const putUrl = new URL(location, externalBase);
  putUrl.searchParams.set("digest", digest);
  const put = await fetch(putUrl, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    // fetch's BodyInit typing wants a plain-ArrayBuffer-backed view, not Buffer<ArrayBufferLike>
    // — the copy is at most one layer (~80 MB), a one-off per seeded image.
    body: new Uint8Array(bytes),
  });
  const putResBody = await put.text();
  if (put.status !== 201) {
    throw new Error(`blob upload PUT ${digest} for ${repository} -> ${put.status}: ${putResBody}`);
  }
  return { digest, size: bytes.byteLength };
}

// Uploads config + the single layer, then PUTs a docker schema2 manifest — a SINGLE manifest
// deliberately, not an index: the daemon unit suite already covers index/arch selection, so the
// integration fixture pins the simpler shape. Returns the manifest's content-address, which is
// exactly what the daemon's resolveDigest() must compute for the tag (sha256 over the raw
// manifest bytes the registry hands back verbatim).
async function seedImage(a: {
  externalBase: string; repository: string; tag: string; layer: Buffer;
}): Promise<{ manifestDigest: string }> {
  const layerBlob = await uploadBlob(a.externalBase, a.repository, a.layer);
  // Minimal config blob: the daemon never fetches it (pullPrefix reads layers only), but
  // registry:2 refuses a manifest whose referenced blobs don't exist, so it must be real.
  const configBytes = Buffer.from(JSON.stringify({
    architecture: process.arch === "arm64" ? "arm64" : "amd64",
    os: "linux",
    rootfs: { type: "layers", diff_ids: [] },
    config: {},
  }));
  const configBlob = await uploadBlob(a.externalBase, a.repository, configBytes);
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    config: {
      mediaType: "application/vnd.docker.container.image.v1+json",
      size: configBlob.size,
      digest: configBlob.digest,
    },
    layers: [{
      // Must satisfy the daemon's /tar(\.|\+)gzip$/ layer-mediaType gate (oci.ts).
      mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip",
      size: layerBlob.size,
      digest: layerBlob.digest,
    }],
  }));
  const put = await fetch(`${a.externalBase}/v2/${a.repository}/manifests/${a.tag}`, {
    method: "PUT",
    headers: { "content-type": "application/vnd.docker.distribution.manifest.v2+json" },
    body: new Uint8Array(manifestBytes),
  });
  const putResBody = await put.text();
  if (put.status !== 201) {
    throw new Error(`manifest PUT ${a.repository}:${a.tag} -> ${put.status}: ${putResBody}`);
  }
  return { manifestDigest: sha256(manifestBytes) };
}

// The REAL image: one gzipped layer built INSIDE the running devdb container from its own baked
// v17 — `tar --transform` renames the `v17/` tree to the `usr/local/` prefix the daemon's puller
// extracts (GNU tar's default transform flags also rewrite hardlink targets consistently, and
// leave the tree's relative symlink targets untouched — they don't start with `v17`). The tgz is
// `docker cp`'d to the host and pushed blob-for-blob. Hermetic by construction: the bytes never
// leave this machine.
export async function seedComputeImageFromDevdb(a: {
  devdb: Devdb; externalBase: string; repository: string; tag: string;
  // When set (e.g. "17.4"), the layer's `bin/postgres` is replaced by a tiny shim that answers
  // `--version` with THIS string while `exec`ing the REAL server (renamed to `bin/postgres.real`)
  // for every other invocation. The daemon's version detection then reads a NON-baked minor — so
  // the same-minor pull dedup (provisioner.extractFixupAndGate) doesn't no-op the pull before it
  // reaches the gate — while the validation gate and a project's endpoint still run the genuine
  // 17.x binary and serve real SQL. This is the integration analog of the unit suite's
  // `pathAwareDetectVersion`. Omit to publish the baked tree verbatim (same minor as baked).
  reportVersion?: string;
}): Promise<{ manifestDigest: string }> {
  const id = a.devdb.container.getId();
  const stage = "/tmp/pgb-fixture-stage";
  if (a.reportVersion === undefined) {
    await execa("docker", ["exec", id, "tar", "-czf", "/tmp/fixture-layer.tgz",
      "--transform", "s|^v17|usr/local|",
      "-C", "/usr/local/share/neon/pg_install", "v17"]);
  } else {
    // Stage a COPY of the baked v17 (patching it in place would corrupt the daemon's OWN baked
    // build), move the real binary aside as `postgres.real`, and drop in the version shim. The
    // shim is base64-piped into place to sidestep heredoc/quoting hazards — $0/$1/$@ must reach
    // the file LITERALLY (they run in the container, not here), and the shebang must sit at column
    // zero. The real 17.x binary still backs `postgres.real`, so find_my_exec resolves share/lib
    // relative to `${stage}/bin/postgres.real` exactly as it would unwrapped.
    const shim = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "postgres (PostgreSQL) ${a.reportVersion}"; exit 0; fi\nexec "$(dirname "$0")/postgres.real" "$@"\n`;
    const shimB64 = Buffer.from(shim).toString("base64");
    await execa("docker", ["exec", id, "sh", "-c",
      `set -e; rm -rf ${stage}; cp -a /usr/local/share/neon/pg_install/v17 ${stage}; ` +
      `mv ${stage}/bin/postgres ${stage}/bin/postgres.real; ` +
      `echo ${shimB64} | base64 -d > ${stage}/bin/postgres; chmod 0755 ${stage}/bin/postgres`]);
    await execa("docker", ["exec", id, "tar", "-czf", "/tmp/fixture-layer.tgz",
      "--transform", "s|^pgb-fixture-stage|usr/local|",
      "-C", "/tmp", "pgb-fixture-stage"]);
  }
  const hostDir = await mkdtemp(join(tmpdir(), "devdb-pgb-fixture-"));
  try {
    const hostTgz = join(hostDir, "layer.tgz");
    await execa("docker", ["cp", `${id}:/tmp/fixture-layer.tgz`, hostTgz]);
    const layer = await readFile(hostTgz);
    return await seedImage({
      externalBase: a.externalBase, repository: a.repository, tag: a.tag, layer,
    });
  } finally {
    await rm(hostDir, { recursive: true, force: true });
    // ~80 MB layer + the staged copy in the container's overlay — drop both (best-effort) once pushed.
    await execa("docker", ["exec", id, "rm", "-rf", "/tmp/fixture-layer.tgz", stage]).catch(() => {});
  }
}

// The STUB image: a tiny layer whose only payload is usr/local/bin/postgres — a shell script
// that answers `--version` with a real-looking banner (so the pull pipeline's fixup
// version-detection accepts it) but cannot serve a compute, so the validation gate MUST fail it
// and leave the active pointer untouched.
export async function seedStubImage(a: {
  externalBase: string; repository: string; tag: string;
  /** Version the fake `postgres --version` reports, e.g. "17.3" — pass a NON-baked minor (distinct
   *  from baked AND from any already-pulled build) so the same-minor pull dedup doesn't no-op this
   *  pull before it reaches the gate it must fail. */
  version: string;
}): Promise<{ manifestDigest: string }> {
  const hostDir = await mkdtemp(join(tmpdir(), "devdb-pgb-stub-"));
  try {
    const binDir = join(hostDir, "scaffold", "usr", "local", "bin");
    await mkdir(binDir, { recursive: true });
    const script = join(binDir, "postgres");
    await writeFile(script, `#!/bin/sh\necho "postgres (PostgreSQL) ${a.version}"\n`);
    await chmod(script, 0o755); // explicit — writeFile's mode is umask-modified
    const tgz = join(hostDir, "stub.tgz");
    // COPYFILE_DISABLE: macOS bsdtar must not emit AppleDouble `._*` members — the daemon-side
    // extraction lists every member, and surprise `._` entries would change the archive shape.
    await execa("tar", ["-czf", tgz, "-C", join(hostDir, "scaffold"), "usr"],
      { env: { COPYFILE_DISABLE: "1" } });
    const layer = await readFile(tgz);
    return await seedImage({
      externalBase: a.externalBase, repository: a.repository, tag: a.tag, layer,
    });
  } finally {
    await rm(hostDir, { recursive: true, force: true });
  }
}
