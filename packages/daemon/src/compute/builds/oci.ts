import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
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

function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

// One layer, applied overlay-style into extractRoot: list the archive, and if it touches the
// prefix at all — apply its whiteouts against lower layers' state, extract just the prefix
// subtree, then drop the `.wh.*` marker files the extract materialized. Layers with no entries
// under the prefix are skipped entirely (GNU tar exits 2 when asked for absent members).
async function applyLayer(a: { spool: string; extractRoot: string; prefix: string }): Promise<void> {
  const listed = await execFileP("tar", ["-tf", a.spool], { maxBuffer: 64 * 1024 * 1024 });
  const entries = listed.stdout.split("\n").filter((line) => line.length > 0);
  const underPrefix = entries.filter((e) => e.startsWith(a.prefix));
  if (underPrefix.length === 0) return;
  const whiteouts = underPrefix.filter((e) => posix.basename(e).startsWith(".wh."));
  for (const entry of whiteouts) {
    const dir = join(a.extractRoot, posix.dirname(entry));
    const name = posix.basename(entry);
    if (name === ".wh..wh..opq") {
      // Opaque whiteout: this layer hides ALL lower-layer contents of the dir (dir itself stays).
      for (const child of await readdir(dir).catch(() => [] as string[])) {
        await rm(join(dir, child), { recursive: true, force: true });
      }
    } else {
      await rm(join(dir, name.slice(".wh.".length)), { recursive: true, force: true });
    }
  }
  await execFileP("tar", ["-xf", a.spool, "-C", a.extractRoot, a.prefix.replace(/\/$/, "")]);
  for (const entry of whiteouts) {
    await rm(join(a.extractRoot, entry), { recursive: true, force: true });
  }
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
    return entry.digest;
  }

  async resolveDigest(repository: string, tag: string): Promise<{ digest: string }> {
    const { body, res } = await this.fetchManifest(repository, tag);
    const parsed = JSON.parse(body.toString("utf8")) as ImageIndex | ImageManifest;
    if ("manifests" in parsed) return { digest: this.selectArch(parsed, repository, tag) };
    const header = res.headers.get("docker-content-digest");
    return { digest: header ?? `sha256:${createHash("sha256").update(body).digest("hex")}` };
  }

  async pullPrefix(a: {
    repository: string;
    digest: string;
    destDir: string;
    prefix: "usr/local/";
    onProgress?: (line: string) => void;
  }): Promise<void> {
    if (await exists(a.destDir)) throw new Error(`destDir already exists: ${a.destDir}`);
    const first = JSON.parse((await this.fetchManifest(a.repository, a.digest)).body.toString("utf8")) as
      | ImageIndex
      | ImageManifest;
    let manifest: ImageManifest;
    if ("manifests" in first) {
      // Caller handed us an index digest — select this arch's manifest, same as resolveDigest.
      const archDigest = this.selectArch(first, a.repository, a.digest);
      manifest = JSON.parse((await this.fetchManifest(a.repository, archDigest)).body.toString("utf8")) as ImageManifest;
    } else {
      manifest = first;
    }
    for (const layer of manifest.layers) {
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
