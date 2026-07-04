import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OciClient } from "../src/compute/builds/oci.js";

const execFileP = promisify(execFile);
const sha256 = (b: Buffer): string => `sha256:${createHash("sha256").update(b).digest("hex")}`;

// ---------------------------------------------------------------------------
// Fixture content: two gzipped tar layers built with the system tar in
// beforeAll, plus per-arch OCI manifests and a manifest index referencing them.
// Layer 2 whiteouts a file layer 1 created (usr/local/.wh.drop-me) and adds
// new content, so extraction must be overlay-aware, not a plain concat.
// ---------------------------------------------------------------------------
let gz1: Buffer;
let gz2: Buffer;
let gz1Digest: string;
let gz2Digest: string;
let amdBytes: Buffer;
let armBytes: Buffer;
let amdDigest: string;
let armDigest: string;
let indexBytes: Buffer;
let indexDigest: string;

const scratchDirs: string[] = [];

async function buildLayerTarGz(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "devdb-oci-layer-"));
  scratchDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  const out = join(dir, "layer.tar.gz");
  // COPYFILE_DISABLE keeps macOS bsdtar from emitting AppleDouble (._*) entries.
  await execFileP("tar", ["-czf", out, "-C", dir, "usr"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return readFile(out);
}

function ociManifest(configSeed: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: sha256(Buffer.from(configSeed)),
        size: configSeed.length,
      },
      layers: [
        { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: gz1Digest, size: gz1.length },
        { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: gz2Digest, size: gz2.length },
      ],
    }),
  );
}

beforeAll(async () => {
  gz1 = await buildLayerTarGz({
    "usr/local/bin/postgres": "#!/bin/sh\necho one\n",
    "usr/local/drop-me": "to be whited out",
    "usr/other/ignored": "outside prefix — must not land in destDir",
  });
  gz2 = await buildLayerTarGz({
    "usr/local/.wh.drop-me": "",
    "usr/local/share/extension/neon.control": "# neon extension\n",
  });
  gz1Digest = sha256(gz1);
  gz2Digest = sha256(gz2);
  amdBytes = ociManifest("config-amd64");
  armBytes = ociManifest("config-arm64");
  amdDigest = sha256(amdBytes);
  armDigest = sha256(armBytes);
  indexBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: amdDigest, size: amdBytes.length, platform: { os: "linux", architecture: "amd64" } },
        { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: armDigest, size: armBytes.length, platform: { os: "linux", architecture: "arm64" } },
      ],
    }),
  );
  indexDigest = sha256(indexBytes);
});

// ---------------------------------------------------------------------------
// In-process registry-v2 fixture: /token, /v2/:repo/manifests/:ref,
// /v2/:repo/blobs/:digest. Counts token hits (the client must only dance when
// challenged) and records which manifest refs were fetched (arch selection).
// ---------------------------------------------------------------------------
interface Fixture {
  base: string;
  tokenHits: number;
  manifestFetches: string[];
  close(): Promise<void>;
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});
afterAll(async () => {
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function startFixture(opts: { challenge?: boolean; corruptDigest?: string }): Promise<Fixture> {
  const fixture: Fixture = { base: "", tokenHits: 0, manifestFetches: [], close: async () => {} };
  const server = http.createServer((req, res) => {
    const send = (code: number, body: Buffer | string, headers: Record<string, string> = {}): void => {
      res.writeHead(code, headers);
      res.end(body);
    };
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    if (path === "/token") {
      fixture.tokenHits += 1;
      return send(200, JSON.stringify({ token: "fixture-token" }), { "content-type": "application/json" });
    }
    if (opts.challenge === true && req.headers.authorization !== "Bearer fixture-token") {
      return send(401, "unauthorized", {
        "www-authenticate": `Bearer realm="${fixture.base}/token",service="fixture-registry",scope="repository:neondatabase/compute-node-v17:pull"`,
      });
    }
    const manifestRef = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(path)?.[2];
    if (manifestRef !== undefined) {
      fixture.manifestFetches.push(manifestRef);
      if (manifestRef === "latest" || manifestRef === indexDigest) {
        return send(200, indexBytes, { "content-type": "application/vnd.oci.image.index.v1+json", "docker-content-digest": indexDigest });
      }
      if (manifestRef === amdDigest) {
        return send(200, amdBytes, { "content-type": "application/vnd.oci.image.manifest.v1+json", "docker-content-digest": amdDigest });
      }
      if (manifestRef === armDigest) {
        return send(200, armBytes, { "content-type": "application/vnd.oci.image.manifest.v1+json", "docker-content-digest": armDigest });
      }
      return send(404, "manifest unknown");
    }
    const blobDigest = /^\/v2\/(.+)\/blobs\/([^/]+)$/.exec(path)?.[2];
    if (blobDigest !== undefined) {
      const bytes = blobDigest === gz1Digest ? gz1 : blobDigest === gz2Digest ? gz2 : null;
      if (!bytes) return send(404, "blob unknown");
      if (opts.corruptDigest === blobDigest) {
        // Flip a byte inside the gzip header's MTIME field: decompressors ignore
        // MTIME, so gunzip still succeeds — but the content-address no longer matches.
        const corrupted = Buffer.from(bytes);
        corrupted.writeUInt8(corrupted.readUInt8(4) ^ 0xff, 4);
        return send(200, corrupted, { "content-type": "application/octet-stream" });
      }
      return send(200, bytes, { "content-type": "application/octet-stream" });
    }
    return send(404, "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixture.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixture.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections(); // undici keep-alive sockets would otherwise stall close()
    });
  fixtures.push(fixture);
  return fixture;
}

async function startFixtureAndClient(
  opts: { challenge?: boolean; corruptDigest?: string; arch?: string } = {},
): Promise<{ fixture: Fixture; client: OciClient; workDir: string; destDir: string }> {
  const fixture = await startFixture(opts);
  const workDir = await mkdtemp(join(tmpdir(), "devdb-oci-work-"));
  scratchDirs.push(workDir);
  const client = new OciClient({ registryBase: fixture.base, arch: opts.arch ?? "amd64" });
  return { fixture, client, workDir, destDir: join(workDir, "dest") };
}

const REPO = "neondatabase/compute-node-v17";

describe("OciClient", () => {
  it("pullPrefix extracts usr/local only, applies whiteouts, verifies layer sha256", async () => {
    const { fixture, client, workDir, destDir } = await startFixtureAndClient();
    const { digest } = await client.resolveDigest(REPO, "latest");
    expect(digest).toBe(amdDigest); // index entry for this client's arch
    const progress: string[] = [];
    await client.pullPrefix({ repository: REPO, digest, destDir, prefix: "usr/local/", onProgress: (line) => progress.push(line) });
    await expect(access(join(destDir, "bin", "postgres"))).resolves.toBeUndefined();
    expect(await readFile(join(destDir, "bin", "postgres"), "utf8")).toBe("#!/bin/sh\necho one\n");
    await expect(access(join(destDir, "share", "extension", "neon.control"))).resolves.toBeUndefined();
    await expect(access(join(destDir, "drop-me"))).rejects.toThrow(); // whiteout applied
    await expect(access(join(destDir, ".wh.drop-me"))).rejects.toThrow(); // marker itself not materialized
    await expect(access(join(destDir, "other"))).rejects.toThrow(); // outside prefix
    expect(progress).toContain("layer 1/2: verified sha256");
    expect(progress).toContain("layer 2/2: verified sha256");
    expect(fixture.tokenHits).toBe(0); // unchallenged registry: no token dance
    expect((await readdir(workDir)).sort()).toEqual(["dest"]); // spool + extract temp dirs cleaned up
  });

  it("selects the manifest matching this arch from an index", async () => {
    const { fixture, client, destDir } = await startFixtureAndClient({ arch: "arm64" });
    const { digest } = await client.resolveDigest(REPO, "latest");
    expect(digest).toBe(armDigest);
    await client.pullPrefix({ repository: REPO, digest, destDir, prefix: "usr/local/" });
    expect(fixture.manifestFetches).toContain(armDigest);
    expect(fixture.manifestFetches).not.toContain(amdDigest);
    await expect(access(join(destDir, "bin", "postgres"))).resolves.toBeUndefined();
  });

  it("rejects on layer sha mismatch", async () => {
    const { client, destDir } = await startFixtureAndClient({ corruptDigest: gz1Digest });
    const { digest } = await client.resolveDigest(REPO, "latest");
    await expect(
      client.pullPrefix({ repository: REPO, digest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/sha256 mismatch/);
    await expect(access(destDir)).rejects.toThrow(); // no partial install left behind
  });

  it("performs the bearer-token dance only when challenged", async () => {
    const { fixture, client, destDir } = await startFixtureAndClient({ challenge: true });
    const { digest } = await client.resolveDigest(REPO, "latest");
    await client.pullPrefix({ repository: REPO, digest, destDir, prefix: "usr/local/" });
    expect(fixture.tokenHits).toBe(1); // challenged once; token cached for every later fetch
    await expect(access(join(destDir, "bin", "postgres"))).resolves.toBeUndefined();
  });
});
