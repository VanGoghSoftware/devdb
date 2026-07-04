import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, readlink, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";

const execFileP = promisify(execFile);

// Zero-dependency Docker-registry-v2 client (Node built-ins + system tar only — the phase's
// hard constraint). Pulls a compute-node image's gzipped tar layers, verifies each layer's
// content-address (sha256 of the COMPRESSED bytes), and extracts ONLY the `usr/local/` prefix
// (the postgres install) overlay-style: whiteouts applied in layer order, then a final
// rename() of the assembled tree onto the caller's destDir.

export interface OciPuller {
  resolveDigest(repository: string, tag: string): Promise<{ digest: string }>;
  pullPrefix(a: {
    repository: string;
    digest: string;
    destDir: string;
    prefix: "usr/local/";
    onProgress?: (line: string) => void;
  }): Promise<void>;
}

// Accept both Docker (list/manifest v2) and OCI (index/manifest v1) media types — Docker Hub
// serves the former for compute-node images, ghcr-style mirrors the latter.
const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

interface IndexEntry {
  digest: string;
  platform?: { os?: string; architecture?: string };
}
interface ImageIndex {
  manifests: IndexEntry[];
}
interface LayerDescriptor {
  mediaType: string;
  digest: string;
  size: number;
}
interface ImageManifest {
  layers: LayerDescriptor[];
}

// `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` (params in any order).
function parseBearerChallenge(header: string | null): { realm: string; service?: string; scope?: string } | null {
  if (header === null || !/^bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) {
    const key = m[1];
    const value = m[2];
    if (key !== undefined && value !== undefined) params[key.toLowerCase()] = value;
  }
  const realm = params.realm;
  if (realm === undefined) return null;
  return { realm, service: params.service, scope: params.scope };
}

const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;

// A content-address is exactly `sha256:` + 64 lowercase hex. Anything else (a tag like `latest`, a
// truncated/wrong-cased hex, another algo) is NOT content-addressed and must never be fetched-and-trusted.
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

// A manifest fetched by content-address (a `sha256:<hex>` ref — the caller's digest, or an
// arch-manifest digest picked from an index) MUST hash to that ref over its RAW response bytes.
// Without this the digest pin is meaningless: a registry (or MITM) could serve a different valid
// manifest under the requested digest. Tag refs aren't content-addressed, so they're not checked.
function verifyManifestDigest(body: Buffer, ref: string): void {
  if (!ref.startsWith("sha256:")) return;
  const got = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (got !== ref) throw new Error(`manifest digest mismatch for ${ref}: got ${got}`);
}

// Discriminate an image index (`manifests[]`) from an image manifest (`layers[]`) with a real shape
// check, and reject a body that is neither — an unchecked `JSON.parse(...) as …` would otherwise
// surface later as an opaque `TypeError` inside `for (const layer of manifest.layers)`.
function parseManifestDoc(body: Buffer, repo: string, ref: string): ImageIndex | ImageManifest {
  let doc: unknown;
  try {
    doc = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error(`malformed manifest for ${repo}@${ref}: not JSON`);
  }
  if (typeof doc !== "object" || doc === null) throw new Error(`malformed manifest for ${repo}@${ref}: not an object`);
  if ("manifests" in doc) {
    if (!Array.isArray(doc.manifests)) throw new Error(`malformed manifest for ${repo}@${ref}: manifests is not an array`);
    return doc as ImageIndex;
  }
  if (!("layers" in doc) || !Array.isArray(doc.layers)) {
    throw new Error(`malformed manifest for ${repo}@${ref}: no layers array`);
  }
  return doc as ImageManifest;
}

// One layer, applied overlay-style into extractRoot: list the archive, and if it touches the
// prefix at all — apply its whiteouts against lower layers' state, extract just the prefix
// subtree, then drop the `.wh.*` marker files the extract materialized. Layers with no entries
// under the prefix are skipped entirely (GNU tar exits 2 when asked for absent members).
async function applyLayer(a: { spool: string; extractRoot: string; prefix: string }): Promise<void> {
  const names = (await execFileP("tar", ["-tf", a.spool], { maxBuffer: 64 * 1024 * 1024 })).stdout
    .split("\n")
    .filter((line) => line.length > 0);

  // --- Fail-closed sanitization. Layers are UNTRUSTED: the per-layer sha check only proves the
  // blob matches the manifest, and a hostile author controls both, so extraction must be safe
  // against hostile member names on its own. This pass MUST precede the whiteout `rm` and the
  // `tar -x` below — the whiteout `rm` runs BEFORE tar and so is NOT covered by tar's own
  // `..`/absolute-path guards; a name like `usr/local/../../etc/cron.d/.wh.x` would otherwise
  // `rm -rf` an arbitrary absolute path as root in-container. Any hostile member rejects the layer.
  //
  // (1) No member ANYWHERE may be absolute or carry a `..` path component. Registry layer changeset
  //     paths are always relative and `..`-free (OCI image-spec), so either means a hostile author.
  //     Checked over every member (not just in-prefix ones) so an absolute member is caught even
  //     though it never matches the `usr/local/` prefix.
  for (const name of names) {
    const norm = posix.normalize(name);
    if (name.startsWith("/") || norm.startsWith("/") || name.split("/").includes("..") || norm.split("/").includes("..")) {
      throw new Error(`unsafe layer entry: ${name}`);
    }
  }
  const underPrefix = names.filter((e) => e.startsWith(a.prefix));
  if (underPrefix.length === 0) return;
  // (2) Every in-prefix member must still normalize to a path under the prefix (belt-and-suspenders
  //     over (1); `posix.normalize` preserves the trailing slash so GNU tar's `usr/local/` dir
  //     listing passes just as bsdtar's slashless form does).
  for (const name of underPrefix) {
    const norm = posix.normalize(name);
    if (norm.startsWith("/") || norm.split("/").includes("..") || !norm.startsWith(a.prefix)) {
      throw new Error(`unsafe layer entry: ${name}`);
    }
  }
  // (3) Member TYPE and link TARGETS are deliberately NOT inspected here. The previous mechanism
  //     parsed `tar -tvf` ls-style text to derive link type/target and validated it pre-extraction;
  //     a security re-review found that fragile — the text is metadata-injectable (owner/group
  //     strings can carry ` -> ` markers) and it validated link targets in ARCHIVE coordinates,
  //     which don't match the final tree after the `usr/local` subtree is renamed onto destDir
  //     (a `usr/local/x -> ../local/y` looks in-prefix in archive coords but escapes destDir once
  //     moved). Instead we let tar extract, then validate the REAL filesystem post-rename in destDir
  //     coordinates (assertSafeExtractedTree, called from pullPrefix). tar's own defaults already
  //     block the dangerous WRITES this pass used to guard: `..`/absolute/through-symlink paths are
  //     refused, and a hardlink whose target isn't an already-extracted in-subtree member fails the
  //     extract outright (verified: bsdtar 3.5.3 + GNU tar 1.34, no `-P`). A symlink is still WRITTEN
  //     verbatim regardless of target, and a special file (fifo/device/socket) is still materialized
  //     — those two are exactly what the post-rename walk rejects.

  // Belt-and-suspenders for the whiteout `rm`s below: even though (1)/(2) already reject `..` and
  // absolute names, assert each resolved target still sits under the extract root before deleting.
  const extractRootResolved = resolve(a.extractRoot);
  const assertUnder = (target: string): void => {
    const t = resolve(target);
    if (t !== extractRootResolved && !t.startsWith(extractRootResolved + sep)) {
      throw new Error(`unsafe whiteout target escapes extract root: ${target}`);
    }
  };

  // Symlink-safe whiteout deletion. `assertUnder` is PURELY LEXICAL — `resolve()` never touches disk,
  // so it cannot see that a PARENT path component of a whiteout target is an on-disk symlink an EARLIER
  // layer planted (layer A: `usr/local/evil -> /outside`; layer B: `usr/local/evil/.wh.foo` or a
  // `.wh..wh..opq`). The whiteout `rm(target)` / opaque `readdir(dir)` would then FOLLOW `evil` out of
  // extractRoot and delete/read outside it — BEFORE the final assertSafeExtractedTree walk rejects the
  // symlink, and with rollback unable to undo the deletion. So before any rm/readdir, walk the parent
  // chain from extractRoot downward with lstat and require EVERY component to be a real (non-symlink)
  // directory. Returns:
  //   true  — whole chain exists and is real dirs: safe to rm/readdir under it.
  //   false — a component doesn't exist yet: nothing to delete (the old force:true rm / `.catch(()=>[])`
  //           readdir were no-ops too), so skip this whiteout without over-rejecting.
  // and THROWS if a component EXISTS but is a symlink or non-directory (the escape vector) — the layer
  // is rejected before any disk mutation.
  const parentChainIsRealDir = async (dir: string): Promise<boolean> => {
    const rel = relative(extractRootResolved, resolve(dir));
    if (rel === "") return true; // dir IS extractRoot (a real dir we mkdtemp'd); assertUnder ran first
    let cur = extractRootResolved;
    for (const part of rel.split(sep)) {
      cur = join(cur, part);
      let st;
      try {
        st = await lstat(cur);
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return false;
        throw err;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`unsafe whiteout: symlink parent component ${cur}`);
      }
    }
    return true;
  };

  const whiteouts = underPrefix.filter((e) => posix.basename(e).startsWith(".wh."));
  for (const entry of whiteouts) {
    const dir = join(a.extractRoot, posix.dirname(entry));
    const name = posix.basename(entry);
    assertUnder(dir);
    if (!(await parentChainIsRealDir(dir))) continue; // parent absent → nothing to whiteout (no-op)
    if (name === ".wh..wh..opq") {
      // Opaque whiteout: this layer hides ALL lower-layer contents of the dir (dir itself stays). `dir`
      // is now a confirmed real in-tree directory, so this readdir cannot traverse a planted symlink.
      for (const child of await readdir(dir)) {
        const target = join(dir, child);
        assertUnder(target);
        await rm(target, { recursive: true, force: true });
      }
    } else {
      const target = join(dir, name.slice(".wh.".length));
      assertUnder(target);
      await rm(target, { recursive: true, force: true });
    }
  }
  await execFileP("tar", ["-xf", a.spool, "-C", a.extractRoot, a.prefix.replace(/\/$/, "")]);
  // Drop the `.wh.*` markers the extract just materialized. Same symlink-safety: confirm each marker's
  // parent chain is real dirs before rm, so a single-layer `usr/local/evil -> /outside` + in-layer
  // `usr/local/evil/.wh.foo` variant cannot make this rm follow the symlink either (tar already refuses
  // to extract THROUGH the symlink, but we do not rely on that here).
  for (const entry of whiteouts) {
    const markerDir = join(a.extractRoot, posix.dirname(entry));
    assertUnder(markerDir);
    if (!(await parentChainIsRealDir(markerDir))) continue;
    const target = join(a.extractRoot, entry);
    assertUnder(target);
    await rm(target, { recursive: true, force: true });
  }
}

// Extract-then-validate link containment: after the assembled `usr/local` subtree has been renamed
// onto destDir, walk the REAL filesystem (`readdir` + `lstat`, NEVER following a symlink) and reject
// anything that has no place in a postgres install. This replaces the old `tar -tvf` text parse:
//   - It is coordinate-correct. Link targets are resolved in destDir's OWN frame — the frame the OS
//     will actually dereference them in — so a `usr/local/x -> ../local/y` that resolved in-prefix in
//     archive coordinates now correctly resolves OUTSIDE destDir and is rejected.
//   - It is metadata-immune. We read the extracted link with `readlink`, never a header/`-tvf` line,
//     so injected owner/group ` -> /evil` text in an archive header can't influence containment.
//   - Containment is per-link and independent: every symlink is validated against destDir on its own,
//     so no chain of symlinks can compose an escape (each hop is individually in-tree).
// A symlink is a validated LEAF — we never descend THROUGH it (lstat reports a symlink-to-dir as a
// symlink, not a directory), so recursion can't be lured out of the tree by a symlinked subdir.
// Hardlinks need no check here: tar only materializes a hardlink whose target is an already-extracted
// in-subtree member (an out-of-subtree/absolute/`..` target fails the extract), so it lands as an
// ordinary regular file inside destDir.
async function assertSafeExtractedTree(destDir: string): Promise<void> {
  const destDirResolved = resolve(destDir);
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const abs = join(dir, name);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        const target = await readlink(abs);
        // Absolute target: escapes the tree by definition. Relative target: resolve it from the
        // link's OWN directory (POSIX symlink semantics) and require the result to stay within destDir.
        if (isAbsolute(target)) {
          throw new Error(`unsafe extracted entry: ${relative(destDir, abs)} -> ${target} (absolute symlink target)`);
        }
        const resolved = resolve(dirname(abs), target);
        if (resolved !== destDirResolved && !resolved.startsWith(destDirResolved + sep)) {
          throw new Error(`unsafe extracted entry: ${relative(destDir, abs)} -> ${target} (symlink escapes install tree)`);
        }
        continue; // leaf — do NOT recurse through the symlink even if it points at a directory
      }
      if (st.isBlockDevice() || st.isCharacterDevice() || st.isFIFO() || st.isSocket()) {
        throw new Error(`unsafe extracted entry: ${relative(destDir, abs)} -> special file (device/fifo/socket)`);
      }
      if (st.isDirectory()) {
        await walk(abs);
        continue;
      }
      // Regular file — the only remaining case for a tar-materialized member; allowed.
    }
  };
  await walk(destDir);
}

export class OciClient implements OciPuller {
  private readonly tokens = new Map<string, string>(); // repo → bearer token (client-lifetime cache)

  constructor(private readonly opts: { registryBase: string; arch?: string }) {}

  private arch(): string {
    return this.opts.arch ?? (process.arch === "arm64" ? "arm64" : "amd64");
  }

  // Anonymous-first GET: only on a 401 Bearer challenge fetch a token from the advertised
  // realm (echoing service+scope back), cache it per repo, and retry once. Docker Hub
  // challenges anonymous pulls; a plain registry:2 never does.
  private async authedFetch(repo: string, url: string, o?: { accept?: string; timeoutMs?: number }): Promise<Response> {
    const timeoutMs = o?.timeoutMs ?? 120_000;
    const attempt = (): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (o?.accept !== undefined) headers.accept = o.accept;
      const token = this.tokens.get(repo);
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      return fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    };
    let res = await attempt();
    if (res.status === 401) {
      const challenge = parseBearerChallenge(res.headers.get("www-authenticate"));
      if (challenge) {
        await res.text().catch(() => ""); // drain the challenge body before retrying
        const tokenUrl = new URL(challenge.realm);
        if (challenge.service !== undefined) tokenUrl.searchParams.set("service", challenge.service);
        if (challenge.scope !== undefined) tokenUrl.searchParams.set("scope", challenge.scope);
        const tokenRes = await fetch(tokenUrl, { signal: AbortSignal.timeout(120_000) });
        if (!tokenRes.ok) {
          const body = await tokenRes.text().catch(() => "");
          throw new Error(`token request ${tokenUrl.href} failed: ${tokenRes.status} ${body.slice(0, 200)}`);
        }
        const tokenJson = (await tokenRes.json()) as { token?: unknown };
        if (typeof tokenJson.token !== "string" || tokenJson.token === "") {
          throw new Error(`token endpoint ${tokenUrl.href} returned no token`);
        }
        this.tokens.set(repo, tokenJson.token);
        res = await attempt();
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GET ${url} failed: ${res.status} ${body.slice(0, 200)}`);
    }
    return res;
  }

  private async fetchManifest(repo: string, ref: string): Promise<{ body: Buffer; res: Response }> {
    const res = await this.authedFetch(repo, `${this.opts.registryBase}/v2/${repo}/manifests/${ref}`, {
      accept: MANIFEST_ACCEPT,
    });
    return { body: Buffer.from(await res.arrayBuffer()), res };
  }

  private selectArch(index: ImageIndex, repo: string, ref: string): string {
    const arch = this.arch();
    const entry = index.manifests.find((m) => m.platform?.os === "linux" && m.platform?.architecture === arch);
    if (!entry) throw new Error(`no linux/${arch} manifest in index ${repo}@${ref}`);
    // Pin the selected descriptor to a real content-address BEFORE it is fetched. If a hostile/broken
    // index points the arch descriptor at a mutable ref (a tag, or a malformed digest), verifyManifestDigest
    // on the fetched arch-manifest would be a silent no-op — so we'd fetch-and-trust arbitrary bytes.
    // Fail closed on anything that isn't sha256:<64hex>, before any arch-manifest/blob fetch.
    if (!SHA256_DIGEST.test(entry.digest)) {
      throw new Error(`index ${repo}@${ref} linux/${arch} descriptor digest is not a sha256 content-address: ${entry.digest}`);
    }
    return entry.digest;
  }

  async resolveDigest(repository: string, tag: string): Promise<{ digest: string }> {
    const { body, res } = await this.fetchManifest(repository, tag);
    const parsed = parseManifestDoc(body, repository, tag);
    if ("manifests" in parsed) return { digest: this.selectArch(parsed, repository, tag) };
    // Direct (single-arch) manifest: the content address is the sha256 of THIS body, computed by us —
    // NEVER the `docker-content-digest` header verbatim. A hostile registry can set that header to a
    // mutable ref like `latest`; pullPrefix would then fetch-and-trust it since verifyManifestDigest
    // no-ops for a non-sha ref. Compute the digest ourselves; if the header is present it MUST equal it.
    const computed = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const header = res.headers.get("docker-content-digest");
    if (header !== null && header !== computed) {
      throw new Error(`docker-content-digest ${header} does not match computed ${computed} for ${repository}@${tag}`);
    }
    return { digest: computed };
  }

  async pullPrefix(a: {
    repository: string;
    digest: string;
    destDir: string;
    prefix: "usr/local/";
    onProgress?: (line: string) => void;
  }): Promise<void> {
    // Public boundary: the digest we pull by MUST be a real content-address. A tag/mutable ref would
    // make verifyManifestDigest a silent no-op (it only checks `sha256:` refs) — fetch-and-trust. Fail
    // closed here, before any network/fs touch, on anything that isn't sha256:<64hex>. (The index →
    // arch-descriptor path from selectArch is already sha-gated; this guards the caller's own arg.)
    if (!SHA256_DIGEST.test(a.digest)) {
      throw new Error(`pullPrefix requires a sha256 content-address digest, got: ${a.digest}`);
    }
    if (await exists(a.destDir)) throw new Error(`destDir already exists: ${a.destDir}`);
    const firstBody = (await this.fetchManifest(a.repository, a.digest)).body;
    verifyManifestDigest(firstBody, a.digest); // content-address pin (no-op for a tag ref)
    const first = parseManifestDoc(firstBody, a.repository, a.digest);
    let manifest: ImageManifest;
    if ("manifests" in first) {
      // Caller handed us an index digest — select this arch's manifest, same as resolveDigest.
      const archDigest = this.selectArch(first, a.repository, a.digest);
      const archBody = (await this.fetchManifest(a.repository, archDigest)).body;
      verifyManifestDigest(archBody, archDigest); // arch-manifest digest is always content-addressed
      const archDoc = parseManifestDoc(archBody, a.repository, archDigest);
      if ("manifests" in archDoc) throw new Error(`unexpected nested index for ${a.repository}@${archDigest}`);
      manifest = archDoc;
    } else {
      manifest = first;
    }
    for (const layer of manifest.layers) {
      // Every layer descriptor digest must itself be a sha256 content-address BEFORE it is interpolated
      // into a blob URL and streamed. Otherwise a malformed manifest could point a layer at a mutable
      // or path-shaped ref and we'd fetch it (the final per-blob hash check comes too late to prevent
      // the fetch). Fail closed on anything that isn't sha256:<64hex>.
      if (!SHA256_DIGEST.test(layer.digest)) {
        throw new Error(`layer descriptor digest is not a sha256 content-address: ${layer.digest}`);
      }
      // …tar.gzip (Docker) / …tar+gzip (OCI); anything else (e.g. zstd) we cannot gunzip.
      if (!/tar(\.|\+)gzip$/.test(layer.mediaType)) {
        throw new Error(`unsupported layer mediaType ${layer.mediaType} for ${layer.digest}`);
      }
    }
    await mkdir(dirname(a.destDir), { recursive: true });
    // Both scratch dirs live NEXT TO destDir, not in os.tmpdir(): the final rename() must not
    // cross filesystems (destDir sits on the data volume in-container; /tmp does not), and the
    // `.tmp-` prefix means a crash's leftovers are swept by BuildRegistry.sweepTmp at next boot
    // and ignored by adoptVolumeBuilds.
    const spoolDir = await mkdtemp(join(dirname(a.destDir), ".tmp-oci-spool-"));
    const extractRoot = await mkdtemp(join(dirname(a.destDir), ".tmp-oci-extract-"));
    try {
      for (const [i, layer] of manifest.layers.entries()) {
        const label = `layer ${i + 1}/${manifest.layers.length}`;
        const spool = join(spoolDir, `layer-${i + 1}.tar`);
        await this.downloadLayer({ repo: a.repository, layer, spool, label, onProgress: a.onProgress });
        await applyLayer({ spool, extractRoot, prefix: a.prefix });
        await rm(spool, { force: true }); // keep peak spool usage to a single layer's tar
      }
      const assembled = join(extractRoot, "usr/local");
      if (!(await exists(assembled))) {
        throw new Error(`image ${a.repository}@${a.digest} has no content under ${a.prefix}`);
      }
      await rename(assembled, a.destDir);
      // Validate the REAL extracted tree in destDir coordinates (symlink containment + special-file
      // rejection). On any unsafe entry, roll back the just-created tree before surfacing the error.
      try {
        await assertSafeExtractedTree(a.destDir);
      } catch (err) {
        await rm(a.destDir, { recursive: true, force: true });
        throw err;
      }
    } finally {
      await rm(spoolDir, { recursive: true, force: true });
      await rm(extractRoot, { recursive: true, force: true });
    }
  }

  // Stream the blob through BOTH a sha256 hash (compressed bytes — the content-address) and
  // gunzip into the spool tar. The computed digest MUST match or the layer is rejected.
  private async downloadLayer(a: {
    repo: string;
    layer: LayerDescriptor;
    spool: string;
    label: string;
    onProgress?: (line: string) => void;
  }): Promise<void> {
    const res = await this.authedFetch(a.repo, `${this.opts.registryBase}/v2/${a.repo}/blobs/${a.layer.digest}`, {
      timeoutMs: 600_000,
    });
    if (res.body === null) throw new Error(`empty response body for blob ${a.layer.digest}`);
    const hash = createHash("sha256");
    const { label, onProgress } = a;
    const total = a.layer.size;
    let received = 0;
    let lastReported = 0;
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        received += chunk.length;
        if (onProgress !== undefined && received - lastReported >= 5 * 1024 * 1024) {
          lastReported = received;
          onProgress(`${label}: ${mb(received)} / ${mb(total)}`);
        }
        callback(null, chunk);
      },
    });
    // Readable.from over the web stream's async iterator (not Readable.fromWeb): the workspace
    // carries two @types/node majors whose `stream/web` ReadableStream declarations collide in
    // fromWeb's parameter; the AsyncIterable shape is version-proof and cancels upstream on destroy.
    await pipeline(Readable.from(res.body), hasher, createGunzip(), createWriteStream(a.spool));
    const got = `sha256:${hash.digest("hex")}`;
    if (got !== a.layer.digest) throw new Error(`sha256 mismatch for layer ${a.layer.digest}: got ${got}`);
    onProgress?.(`${label}: verified sha256`);
  }
}
