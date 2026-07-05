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
type TarType = "0" | "2" | "5" | "1" | "6"; // regular | symlink | dir | hardlink | fifo
interface TarEntry {
  name: string;
  type: TarType;
  content?: string;
  linkname?: string;
  uname?: string; // owner name — used to plant a fake " -> /evil" marker in header metadata
  gname?: string; // group name
}
function tarHeader(o: {
  name: string;
  type: string;
  size: number;
  linkname?: string;
  mode?: number;
  uname?: string;
  gname?: string;
}): Buffer {
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
  if (o.uname !== undefined) put(o.uname, 265, 32); // uname field (USTAR)
  if (o.gname !== undefined) put(o.gname, 297, 32); // gname field
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
    const bodyless = e.type === "2" || e.type === "5" || e.type === "1" || e.type === "6";
    const size = bodyless ? 0 : content.length;
    parts.push(tarHeader({ name: e.name, type: e.type, size, linkname: e.linkname, uname: e.uname, gname: e.gname }));
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

  // --- Fix round 3: link containment moved from a pre-extraction `tar -tvf` text parse to an
  // extract-then-validate walk of the REAL filesystem (assertSafeExtractedTree), in destDir
  // coordinates. C1(d) (absolute-target symlink) folded into the round-2 absolute-target test below,
  // which now asserts the post-extraction rejection message. Legit in-tree relative symlinks still
  // pass (real compute-node images ship hundreds, e.g. `lib/libpq.so.5 -> libpq.so.5.17`). ---

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

  it("rejects an absolute-target symlink (caught post-extraction by the destDir walk)", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/link", type: "2", linkname: "/etc/passwd" },
    ]);
    const victim = await plantVictim(workDir);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe extracted entry/);
    expect(await readFile(victim, "utf8")).toBe("PRECIOUS");
    await expect(access(destDir)).rejects.toThrow(); // rolled back after the walk rejected the link
  });

  it("rejects an escaping relative-target symlink (resolves outside usr/local/ via ../..)", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/link", type: "2", linkname: "../../../../etc/passwd" },
    ]);
    const victim = await plantVictim(workDir);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe extracted entry/);
    expect(await readFile(victim, "utf8")).toBe("PRECIOUS");
    await expect(access(destDir)).rejects.toThrow();
  });

  // THE coordinate-confusion case the rewrite exists to fix. `usr/local/link -> ../local/payload`
  // looks in-prefix in ARCHIVE coordinates (`usr/local/../local/payload` == `usr/local/payload`), so
  // the old pre-extraction `tar -tvf` check ACCEPTED it. But after `rename(extractRoot/usr/local,
  // destDir)` the link sits at `destDir/link` and `../local/payload` resolves to a sibling of destDir
  // — OUTSIDE the install tree. The post-rename walk evaluates it in destDir coordinates and rejects.
  it("rejects a `../local/`-reenter symlink that only looks in-tree in archive coordinates", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/payload", type: "0", content: "p" },
      { name: "usr/local/link", type: "2", linkname: "../local/payload" },
    ]);
    const victim = await plantVictim(workDir);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe extracted entry/);
    expect(await readFile(victim, "utf8")).toBe("PRECIOUS");
    await expect(access(destDir)).rejects.toThrow(); // whole pull rolled back, not just the one link
  });

  // Fable Minor #6 (final whole-branch review, folded into the FIX pass — defense-in-depth):
  // assertSafeExtractedTree walks CHILDREN of destDir but never lstats the renamed assembled node
  // itself. `usr/local` CAN end up a symlink after extraction (here: an in-prefix `usr/local/`
  // dir member so the layer isn't skipped, then a `usr/local` symlink member replacing the
  // still-empty dir — bsdtar 3.5.3 performs that replace, exit 0). Pre-fix, exists() follows the
  // link, rename() moves the LINK to destDir, and the walk then validates whatever tree the link
  // points at in destDir's OWN frame — never the link itself. (In this fixture the target
  // dangles post-rename, so the pre-fix failure surfaces as a confusing mid-walk ENOENT after
  // the rename already happened; a target that resolves in destDir's frame would be validated
  // as if it were the install.) The assembled node must be a REAL directory, checked pre-rename.
  it("rejects a layer where usr/local itself is a symlink — the install root must be a real directory", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/", type: "5" }, // in-prefix member: the layer is applied, not skipped
      { name: "usr/local", type: "2", linkname: "../../victim" }, // replaces the empty dir
    ]);
    const victim = await plantVictim(workDir);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/not a real directory/);
    expect(await readFile(victim, "utf8")).toBe("PRECIOUS");
    await expect(lstat(destDir)).rejects.toThrow(); // the symlink was never renamed into place
  });

  it("rejects a special-file (FIFO) member — no place in a pg install", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/bin/postgres", type: "0", content: "ok" }, // benign regular content alongside
      { name: "usr/local/pipe", type: "6" }, // FIFO — tar materializes it; the walk must reject it
    ]);
    const victim = await plantVictim(workDir);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe extracted entry/);
    expect(await readFile(victim, "utf8")).toBe("PRECIOUS");
    await expect(access(destDir)).rejects.toThrow();
  });

  // Containment no longer depends on ANY tar header text, so an injected marker is inert. This layer's
  // header owner/group carry a fake ` -> /evil` string (the exact shape that could confuse an ls-style
  // `-tvf` parse), but the REAL symlink target is in-tree — so the pull must SUCCEED.
  it("passes a symlink whose header metadata carries a fake ` -> /evil` marker (metadata is moot)", async () => {
    const { client, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/liby.so.1", type: "0", content: "shared object bytes" },
      { name: "usr/local/liby.so", type: "2", linkname: "liby.so.1", uname: "x -> /evil", gname: "y -> /evil" },
    ]);
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).resolves.toBeUndefined();
    const st = await lstat(join(destDir, "liby.so"));
    expect(st.isSymbolicLink()).toBe(true);
    expect(await readlink(join(destDir, "liby.so"))).toBe("liby.so.1"); // the real, in-tree target
  });

  // --- Hardlinks need no post-extraction check: tar only ever materializes a hardlink whose target
  // is an ALREADY-EXTRACTED member of the same `usr/local` subtree (a target that is absolute, carries
  // `..`, or simply isn't extracted fails the extract outright — verified against both bsdtar 3.5.3 and
  // GNU tar 1.34 / node:22-bookworm-slim). So a materialized hardlink lands as an ordinary regular file
  // inside destDir, and an escaping one never lands at all. These two tests pin that tar boundary. ---

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

  it("rejects a hardlink whose target escapes usr/local/ (tar refuses: target not in the extracted subtree)", async () => {
    const { client, workDir, destDir, manifestDigest } = await hostileLayerClient([
      { name: "usr/local/bin/hardlinked", type: "1", linkname: "usr/other/evil.txt" },
    ]);
    const victim = await plantVictim(workDir);
    // The out-of-subtree hardlink target is never extracted (we ask tar for `usr/local` only), so the
    // extract itself fails; the pull throws and nothing is left behind. (Message is tar's, not ours.)
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow();
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

  // P2 residual: an arch descriptor selected from an index must itself be a sha256 content-address,
  // or verifyManifestDigest on the fetched arch-manifest would be a silent no-op and we'd fetch-and-
  // trust a mutable ref. The index body here is served verbatim under its OWN true sha256 (so the
  // index passes verification), but its amd64 descriptor points at the tag `latest` — selectArch must
  // fail closed BEFORE fetching that descriptor or any blob.
  it("rejects a non-sha256 index descriptor before fetching the arch manifest or any blob", async () => {
    const badIndex = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "latest", size: 100, platform: { os: "linux", architecture: "amd64" } },
          { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: armDigest, size: armBytes.length, platform: { os: "linux", architecture: "arm64" } },
        ],
      }),
    );
    const badIndexDigest = sha256(badIndex);
    const { fixture, client, destDir } = await startFixtureAndClient({
      manifestOverrides: { [badIndexDigest]: badIndex },
    });
    await expect(
      client.pullPrefix({ repository: REPO, digest: badIndexDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/not a sha256 content-address/);
    expect(fixture.manifestFetches).toEqual([badIndexDigest]); // only the index; the bad descriptor was never fetched
    expect(fixture.manifestFetches).not.toContain("latest");
    expect(fixture.blobFetches).toEqual([]);
    await expect(access(destDir)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fix round 4: whiteout-symlink-parent containment + digest pinning.
//   P1 — a whiteout rm/readdir must not follow a symlink PARENT component an earlier layer planted
//        (the lexical assertUnder never sees an on-disk symlink; the final tree walk runs too late).
//   P2 — a direct (single) manifest's content-address must be the VERIFIED sha256 of its body, not a
//        docker-content-digest header a hostile registry can set to a mutable ref; pullPrefix's public
//        `digest` arg must itself be a sha256.
//   P3 — every layer descriptor digest must be a sha256 content-address before any blob fetch.
// ---------------------------------------------------------------------------
describe("OciClient — whiteout-symlink & digest-pin hardening (round 4)", () => {
  function twoLayerManifest(gzA: Buffer, gzB: Buffer): { body: Buffer; digest: string } {
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha256(Buffer.from("cfg")), size: 3 },
        layers: [
          { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: sha256(gzA), size: gzA.length },
          { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: sha256(gzB), size: gzB.length },
        ],
      }),
    );
    return { body, digest: sha256(body) };
  }

  // A two-layer image whose layers are built AFTER we know workDir, so layer A's symlink can point at
  // an ABSOLUTE path OUTSIDE extractRoot (the `victim` dir, a sibling of pullPrefix's `.tmp-oci-extract-*`).
  // `makeLayers(victimDir)` returns the two layers' members; the victim file is planted at victimDir/evil.
  async function twoLayerVictimSetup(
    makeLayers: (victimDir: string) => { a: TarEntry[]; b: TarEntry[] },
  ): Promise<{ client: OciClient; fixture: Fixture; destDir: string; victimFile: string; manifestDigest: string }> {
    const workDir = await mkdtemp(join(tmpdir(), "devdb-oci-work-"));
    scratchDirs.push(workDir);
    const victimDir = join(workDir, "victim");
    await mkdir(victimDir, { recursive: true });
    const victimFile = join(victimDir, "evil");
    await writeFile(victimFile, "PRECIOUS");
    const { a, b } = makeLayers(victimDir);
    const gzA = gzipSync(makeTar(a));
    const gzB = gzipSync(makeTar(b));
    const { body: manifestBody, digest: manifestDigest } = twoLayerManifest(gzA, gzB);
    const fixture = await startFixture({
      manifestOverrides: { [manifestDigest]: manifestBody },
      blobOverrides: { [sha256(gzA)]: gzA, [sha256(gzB)]: gzB },
    });
    const client = new OciClient({ registryBase: fixture.base, arch: "amd64" });
    return { client, fixture, destDir: join(workDir, "dest"), victimFile, manifestDigest };
  }

  it("P1(a): rejects a `.wh.` whiteout under a symlinked parent an earlier layer planted — the outside victim survives", async () => {
    // Layer A plants `usr/local/sneak` as an ABSOLUTE symlink to the outside victim dir; layer B's
    // whiteout `usr/local/sneak/.wh.evil` would (unpatched) `rm(extractRoot/usr/local/sneak/evil)` and,
    // following `sneak`, delete the real victimDir/evil OUTSIDE extractRoot.
    const { client, destDir, victimFile, manifestDigest } = await twoLayerVictimSetup((victimDir) => ({
      a: [{ name: "usr/local/sneak", type: "2", linkname: victimDir }],
      b: [{ name: "usr/local/sneak/.wh.evil", type: "0", content: "" }],
    }));
    // Accept EITHER rejection message: the load-bearing `parentChainIsRealDir` guard (which runs BEFORE
    // any rm and so prevents the deletion), OR the round-2 assertSafeExtractedTree backstop (which only
    // runs AFTER extraction/rename and so — on production GNU tar — would reject too late, having let the
    // whiteout `rm` already delete the outside victim). The message is secondary; see below.
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe whiteout: symlink parent component|unsafe extracted entry/);
    // PRIMARY security assertion: the outside victim must still contain its original sentinel content.
    // This is the assertion that actually distinguishes the two failure modes above — "guard fired
    // before rm" (victim survives) from "backstop caught it after rm" (victim already gone). Asserting
    // only on the rejection message would pass either way and prove nothing about WHEN the rejection
    // happened; this is what proves parentChainIsRealDir — not the tree-walk backstop — is what stops
    // the deletion on real GNU tar.
    expect(await readFile(victimFile, "utf8")).toBe("PRECIOUS");
    await expect(access(destDir)).rejects.toThrow(); // nothing materialized
  });

  it("P1(b): rejects an opaque `.wh..wh..opq` whiteout under a symlinked parent — the outside victim survives", async () => {
    // Same symlink plant; layer B's opaque marker would (unpatched) `readdir(extractRoot/usr/local/sneak)`
    // — following `sneak` into the outside victim dir — and rm every child (deleting victimDir/evil).
    const { client, destDir, victimFile, manifestDigest } = await twoLayerVictimSetup((victimDir) => ({
      a: [{ name: "usr/local/sneak", type: "2", linkname: victimDir }],
      b: [{ name: "usr/local/sneak/.wh..wh..opq", type: "0", content: "" }],
    }));
    // See P1(a) above: either message is acceptable (guard vs. backstop), but the victim-survival
    // assertion below is the one that actually proves the guard — not the backstop — stopped the rm.
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe whiteout: symlink parent component|unsafe extracted entry/);
    // PRIMARY security assertion — see the comment in P1(a): this is the load-bearing check, not the
    // rejection message above. If parentChainIsRealDir were removed, this would fail (victim deleted)
    // even though the pull would still reject via the round-2 backstop with a different message.
    expect(await readFile(victimFile, "utf8")).toBe("PRECIOUS");
    await expect(access(destDir)).rejects.toThrow();
  });

  it("P1(c): a benign nested whiteout with only REAL dir parents still applies (no over-rejection)", async () => {
    // Layer A creates a real dir `usr/local/realdir` with a file; layer B whiteouts that file and adds a
    // sibling. Every parent component is a real directory, so the whiteout must apply and the pull succeed.
    const { client, destDir, manifestDigest } = await twoLayerVictimSetup(() => ({
      a: [
        { name: "usr/local/bin/postgres", type: "0", content: "ok" },
        { name: "usr/local/realdir/keep.txt", type: "0", content: "old" },
      ],
      b: [
        { name: "usr/local/realdir/.wh.keep.txt", type: "0", content: "" },
        { name: "usr/local/realdir/new.txt", type: "0", content: "new" },
      ],
    }));
    await client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" });
    expect(await readFile(join(destDir, "bin", "postgres"), "utf8")).toBe("ok");
    expect(await readFile(join(destDir, "realdir", "new.txt"), "utf8")).toBe("new");
    await expect(access(join(destDir, "realdir", "keep.txt"))).rejects.toThrow(); // whiteout applied
    await expect(access(join(destDir, "realdir", ".wh.keep.txt"))).rejects.toThrow(); // marker cleaned
  });

  it("P1(d): rejects a whiteout reached through an IN-TREE relative symlink dir alias (deliberate over-rejection)", async () => {
    // Layer A creates a real target dir `usr/local/lib64/old.so` AND a relative in-tree symlink alias
    // `usr/local/lib -> lib64` (both endpoints stay inside usr/local/ — this is the shape the "legit
    // in-tree relative symlink" test elsewhere in this file accepts as a normal PASS for non-whiteout
    // extraction). Layer B whiteouts THROUGH the alias: `usr/local/lib/.wh.old.so`. parentChainIsRealDir
    // walks `usr/local/lib` and finds a symlink (not a real dir) as a parent COMPONENT of the whiteout
    // target, so it throws — even though the alias never leaves usr/local/ and the whiteout's ultimate
    // target (`usr/local/lib64/old.so`) is itself perfectly in-tree.
    //
    // This is a DELIBERATE safety-over-availability decision, not a bug: parentChainIsRealDir only asks
    // "is every parent component a real (non-symlink) directory", never "does this symlink's target stay
    // in-tree" — resolving the latter for every parent of every whiteout, on every pull, would add real
    // cost and complexity to a guard that exists for a narrow adversarial case. Real Docker/OCI image
    // layers emit whiteouts at CANONICAL paths (the path the file was actually created at), never through
    // a symlink alias — so this only over-rejects adversarial/unusual layers, never a normal image. See
    // the comment at `parentChainIsRealDir` in oci.ts for the revisit condition.
    const { client, destDir, manifestDigest } = await twoLayerVictimSetup(() => ({
      a: [
        { name: "usr/local/lib64/old.so", type: "0", content: "old" },
        { name: "usr/local/lib", type: "2", linkname: "lib64" },
      ],
      b: [{ name: "usr/local/lib/.wh.old.so", type: "0", content: "" }],
    }));
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/unsafe whiteout: symlink parent component/);
  });

  it("P2: resolveDigest rejects a direct manifest whose docker-content-digest header is a mutable ref (latest)", async () => {
    // A single-arch manifest served under the tag `latest` with docker-content-digest: latest. resolveDigest
    // must compute the real sha256 of the body and reject the mismatched header — never return `latest`.
    const manifestBody = singleManifest(gz1, gz1Digest);
    const { fixture, client } = await startFixtureAndClient({ manifestOverrides: { latest: manifestBody } });
    await expect(client.resolveDigest(REPO, "latest")).rejects.toThrow(/docker-content-digest/);
    expect(fixture.blobFetches).toEqual([]);
  });

  it("P2: resolveDigest returns the VERIFIED sha256 of a direct manifest (not the header verbatim)", async () => {
    // Header equals the true digest here — resolveDigest returns that computed sha256 content-address.
    const manifestBody = singleManifest(gz1, gz1Digest);
    const manifestDigest = sha256(manifestBody);
    const { client } = await startFixtureAndClient({ manifestOverrides: { [manifestDigest]: manifestBody } });
    const { digest } = await client.resolveDigest(REPO, manifestDigest);
    expect(digest).toBe(manifestDigest);
  });

  it("P2: pullPrefix rejects a non-sha256 `digest` arg at the boundary — no manifest or blob fetch", async () => {
    const { fixture, client, destDir } = await startFixtureAndClient({});
    await expect(
      client.pullPrefix({ repository: REPO, digest: "latest", destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/sha256 content-address/);
    expect(fixture.manifestFetches).toEqual([]);
    expect(fixture.blobFetches).toEqual([]);
    await expect(access(destDir)).rejects.toThrow();
  });

  it("P3: rejects a manifest with a non-sha256 layer descriptor digest, before any blob fetch", async () => {
    const manifestBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha256(Buffer.from("cfg")), size: 3 },
        layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: "latest", size: 10 }],
      }),
    );
    const manifestDigest = sha256(manifestBody);
    const { fixture, client, destDir } = await startFixtureAndClient({ manifestOverrides: { [manifestDigest]: manifestBody } });
    await expect(
      client.pullPrefix({ repository: REPO, digest: manifestDigest, destDir, prefix: "usr/local/" }),
    ).rejects.toThrow(/not a sha256 content-address/);
    // PRIMARY assertion: zero blob fetches happened. This directly proves the preflight rejected the
    // descriptor BEFORE any fetch was attempted — if the preflight were removed, the client would fetch
    // `blobs/latest` and fail with an unrelated fixture 404, which would still satisfy a message-only
    // rejection check but would NOT satisfy this assertion. So this — not the rejection message above —
    // is what actually catches a dropped preflight.
    expect(fixture.blobFetches).toEqual([]);
    await expect(access(destDir)).rejects.toThrow();
  });
});
