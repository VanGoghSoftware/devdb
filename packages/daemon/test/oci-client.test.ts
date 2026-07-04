import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
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

// --- Hand-crafted USTAR tar builder, for adversarial layers the system `tar -c` refuses to
// produce (absolute names, `..` components, symlinks). One 512-byte header per member (+ padded
// body), two zero blocks terminate the archive. `tar -tf`/`-tvf` list these verbatim (verified:
// bsdtar 3.5.3 preserves `..` and leading `/` in listings, and encodes member type as the first
// char of the `-tvf` mode string). ---
type TarType = "0" | "2" | "5" | "1"; // regular | symlink | dir | hardlink
interface TarEntry {
  name: string;
  type: TarType;
  content?: string;
  linkname?: string;
}
function tarHeader(o: { name: string; type: string; size: number; linkname?: string; mode?: number }): Buffer {
  const h = Buffer.alloc(512, 0);
  const put = (s: string, off: number, len: number): void => {
    Buffer.from(s, "utf8").copy(h, off, 0, Math.min(Buffer.byteLength(s), len));
  };
  const octal = (n: number, off: number, len: number): void => {
    put(n.toString(8).padStart(len - 1, "0"), off, len - 1);
    h[off + len - 1] = 0;
  };
  put(o.name, 0, 100);
  octal(o.mode ?? 0o644, 100, 8);
  octal(0, 108, 8); // uid
  octal(0, 116, 8); // gid
  octal(o.size, 124, 12);
  octal(0, 136, 12); // mtime
  for (let i = 148; i < 156; i++) h[i] = 0x20; // chksum field = spaces while summing
  h[156] = o.type.charCodeAt(0); // typeflag
  if (o.linkname !== undefined) put(o.linkname, 157, 100);
  put("ustar", 257, 6); // magic
  h[263] = 0x30; // version "00"
  h[264] = 0x30;
  const sum = h.reduce((s, b) => s + b, 0);
  put(sum.toString(8).padStart(6, "0"), 148, 6);
  h[154] = 0;
  h[155] = 0x20;
  return h;
}
function makeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const content = Buffer.from(e.content ?? "", "utf8");
    const bodyless = e.type === "2" || e.type === "5" || e.type === "1";
    const size = bodyless ? 0 : content.length;
    parts.push(tarHeader({ name: e.name, type: e.type, size, linkname: e.linkname }));
    if (size > 0) {
      parts.push(content);
      const pad = (512 - (size % 512)) % 512;
      if (pad > 0) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}
function singleManifest(layerGz: Buffer, layerDigest: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha256(Buffer.from("cfg")), size: 3 },
      layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: layerDigest, size: layerGz.length }],
    }),
  );
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
  blobFetches: string[];
  close(): Promise<void>;
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});
afterAll(async () => {
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function startFixture(opts: {
  challenge?: boolean;
  corruptDigest?: string;
  manifestOverrides?: Record<string, Buffer>;
  blobOverrides?: Record<string, Buffer>;
}): Promise<Fixture> {
  const fixture: Fixture = { base: "", tokenHits: 0, manifestFetches: [], blobFetches: [], close: async () => {} };
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
      const mOverride = opts.manifestOverrides?.[manifestRef];
      if (mOverride !== undefined) {
        // Serve the override body VERBATIM under the requested ref (digest NOT recomputed) — this is
        // how a substituted / malformed manifest reaches the client's own verification.
        return send(200, mOverride, {
          "content-type": "application/vnd.oci.image.manifest.v1+json",
          "docker-content-digest": manifestRef,
        });
      }
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
      fixture.blobFetches.push(blobDigest);
      const bOverride = opts.blobOverrides?.[blobDigest];
      if (bOverride !== undefined) return send(200, bOverride, { "content-type": "application/octet-stream" });
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
  opts: {
    challenge?: boolean;
    corruptDigest?: string;
    arch?: string;
    manifestOverrides?: Record<string, Buffer>;
    blobOverrides?: Record<string, Buffer>;
  } = {},
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

// ---------------------------------------------------------------------------
// Adversarial layers & manifest content-address pinning (security fix round 1).
// Threat model: image layers are UNTRUSTED — the per-layer sha only proves the
// blob matches the manifest, and one hostile author controls both. Extraction
// must be safe against hostile member names ON ITS OWN.
// ---------------------------------------------------------------------------
describe("OciClient — untrusted-layer & manifest-pin hardening", () => {
  // Build a single-layer image around a hostile tar and register its manifest + blob so the
  // client will fetch, sha-verify, gunzip, and then attempt to APPLY the layer (where the
  // sanitization must fire). Returns the digest to pull by.
  async function hostileLayerClient(
    members: TarEntry[],
  ): Promise<{ client: OciClient; fixture: Fixture; workDir: string; destDir: string; manifestDigest: string }> {
    const gz = gzipSync(makeTar(members));
    const layerDigest = sha256(gz);
    const manifestBody = singleManifest(gz, layerDigest);
    const manifestDigest = sha256(manifestBody);
    const h = await startFixtureAndClient({
      manifestOverrides: { [manifestDigest]: manifestBody },
      blobOverrides: { [layerDigest]: gz },
    });
    return { ...h, manifestDigest };
  }

  // Plant a victim OUTSIDE the extract tree: a sibling of the `.tmp-oci-extract-*` dir that
  // pullPrefix mkdtemps under workDir (= dirname(destDir)). The `usr/local/../../../victim/…`
  // members below escape extractRoot by exactly one level to land on it — so if any whiteout `rm`
  // runs, this file disappears. Returns the victim file path.
  async function plantVictim(workDir: string): Promise<string> {
    const victim = join(workDir, "victim");
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, "evil"), "PRECIOUS");
    return join(victim, "evil");
  }

  it("C1(a): rejects a `.wh.` whiteout that traverses out of the extract tree — no rm runs", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/../../../victim/.wh.evil", type: "0", content: "" },
    ]);
    const victim = await plantVictim(workDir);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe layer entry/);
    expect(await readFile(victim, "utf8")).toBe("PRECIOUS"); // fail-closed: the out-of-tree rm never ran
    await expect(access(destDir)).rejects.toThrow(); // no partial install materialized
  });

  it("C1(b): rejects an absolute-path member (fail-closed even though it misses the prefix)", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/bin/postgres", type: "0", content: "ok" }, // benign in-prefix content
      { name: "/etc/cron.d/evil", type: "0", content: "pwn" }, // absolute — rejects the whole layer
    ]);
    const victim = await plantVictim(workDir);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe layer entry/);
    expect(await readFile(victim, "utf8")).toBe("PRECIOUS");
    await expect(access(destDir)).rejects.toThrow();
  });

  it("C1(c): rejects an opaque `.wh..wh..opq` whiteout that traverses out of the extract tree", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/../../../victim/.wh..wh..opq", type: "0", content: "" },
    ]);
    const victim = await plantVictim(workDir);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe layer entry/);
    expect(await readFile(victim, "utf8")).toBe("PRECIOUS"); // an opaque rm would have cleared the dir
    await expect(access(destDir)).rejects.toThrow();
  });

  it("C1(d): rejects an absolute-target symlink member under the prefix (would land in destDir pointing outside)", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/evil-link", type: "2", linkname: "/etc/passwd" },
    ]);
    const victim = await plantVictim(workDir);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe layer entry/);
    expect(await readFile(victim, "utf8")).toBe("PRECIOUS");
    await expect(access(destDir)).rejects.toThrow(); // the out-pointing symlink never reached destDir
  });

  // --- Fix round 2: symlink policy refined from "reject all links" to TARGET-CONTAINMENT. Real
  // compute-node images ship hundreds of legitimate in-tree relative symlinks under usr/local
  // (`lib/libpq.so.5 -> libpq.so.5.17`); a blanket ban would fail every real pull. ---

  it("passes a legit in-tree relative symlink (target stays inside usr/local/)", async () => {
    const { client, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/lib/libx.so.5.17", type: "0", content: "shared object bytes" },
      { name: "usr/local/lib/libx.so.5", type: "2", linkname: "libx.so.5.17" },
    ]);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).resolves.toBeUndefined();
    const st = await lstat(join(destDir, "lib", "libx.so.5"));
    expect(st.isSymbolicLink()).toBe(true);
    expect(await readlink(join(destDir, "lib", "libx.so.5"))).toBe("libx.so.5.17");
  });

  it("rejects an absolute-target symlink (refined policy: still rejected)", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/link", type: "2", linkname: "/etc/passwd" },
    ]);
    const victim = await plantVictim(workDir);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe layer entry/);
    expect(await readFile(victim, "utf8")).toBe("PRECIOUS");
    await expect(access(destDir)).rejects.toThrow();
  });

  it("rejects an escaping relative-target symlink (resolves outside usr/local/ via ../..)", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/link", type: "2", linkname: "../../../../etc/passwd" },
    ]);
    const victim = await plantVictim(workDir);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe layer entry/);
    expect(await readFile(victim, "utf8")).toBe("PRECIOUS");
    await expect(access(destDir)).rejects.toThrow();
  });

  // --- Hardlink target semantics DIFFER from symlinks (verified empirically against both bsdtar
  // 3.5.3 and GNU tar 1.34 / node:22-bookworm-slim, the container base image): a hardlink's
  // `-tvf` line uses " link to " (not " -> "), and its target is an ARCHIVE-ROOT-RELATIVE path
  // (same shape as any member name) — NOT resolved against the member's own directory the way a
  // symlink's relative target is. These two tests exercise that path specifically; the raw USTAR
  // `linkname` field is confirmed (by direct header inspection) to already hold the full
  // archive-relative path, so `TarEntry.linkname` below is written the same way real tar does. ---

  it("passes a legit in-tree hardlink whose target is an archive-relative path under usr/local/", async () => {
    const { client, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/lib/orig.txt", type: "0", content: "shared object bytes" },
      { name: "usr/local/bin/hardlinked", type: "1", linkname: "usr/local/lib/orig.txt" },
    ]);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).resolves.toBeUndefined();
    await expect(access(join(destDir, "bin", "hardlinked"))).resolves.toBeUndefined();
  });

  it("rejects a hardlink whose archive-relative target escapes usr/local/ (not dirname-joined)", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/bin/hardlinked", type: "1", linkname: "usr/other/evil.txt" },
    ]);
    const victim = await plantVictim(workDir);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe layer entry/);
    expect(await readFile(victim, "utf8")).toBe("PRECIOUS");
    await expect(access(destDir)).rejects.toThrow();
  });

  it("P2: rejects a manifest whose body does not match the requested content-address, before any blob download", async () => {
    // Serve a valid-but-different manifest (arm) under the amd digest the caller pins.
    const { fixture, client, destDir } = await startFixtureAndClient({
      manifestOverrides: { [amdDigest]: armBytes },
    });
    await expect(
      client.pullPrefix({ repository: REPO, digest: amdDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/manifest digest mismatch/);
    expect(fixture.blobFetches).toEqual([]); // rejected BEFORE any layer download/extraction
    await expect(access(destDir)).rejects.toThrow();
  });

  it("M1: rejects a manifest that is neither an index nor a layer manifest", async () => {
    const malformed = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" }));
    const malformedDigest = sha256(malformed);
    const { fixture, client, destDir } = await startFixtureAndClient({
      manifestOverrides: { [malformedDigest]: malformed },
    });
    await expect(
      client.pullPrefix({ repository: REPO, digest: malformedDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/malformed manifest/);
    expect(fixture.blobFetches).toEqual([]);
  });
});
