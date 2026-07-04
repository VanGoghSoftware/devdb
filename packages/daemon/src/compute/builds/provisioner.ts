import { execFile } from "node:child_process";
import { rename, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DevdbError } from "../../services/errors.js";
import type { StateDb } from "../../state/db.js";
import type { PgBuildRow } from "../../state/repos.js";
import { shortDigest } from "./registry.js";
import type { BuildRegistry } from "./registry.js";
import type { OciPuller } from "./oci.js";
import type { LogsService } from "../../services/logs.js";
import type { EventsService } from "../../services/events.js";

const execFileP = promisify(execFile);

const MIN_FREE_BYTES = 1.5 * 2 ** 30;
const GATE_TIMEOUT_MS = 90_000;

// OCI distribution-spec tag grammar. Belt-and-suspenders: build paths are digest-derived (a tag
// never becomes a filesystem name), but the tag still flows to resolveDigest URLs and into row
// metadata, so reject anything malformed before any row/path/network work happens.
const OCI_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// Real `du -sk` default (index.ts wires this in) — kilobyte total of a directory tree, converted
// to bytes. Returns null (never throws) on any failure: sizeBytes is informational, not load-bearing.
export async function du(dir: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP("du", ["-sk", dir]);
    const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

// Real free-space default (index.ts wires this in) — bytes free on the filesystem backing `dir`.
export async function statfsFree(dir: string): Promise<number> {
  const st = await statfs(dir);
  return st.bavail * st.bsize;
}

// First line of an error's message, capped — used for the row's short-form `error` column so a
// stack trace or a giant validation dump never lands in SQLite/the UI badge.
export function firstLine(e: unknown): string {
  const msg = String((e as Error).message ?? e);
  return msg.split("\n")[0]!.slice(0, 500);
}

interface CheckResult { tag: "latest"; digest: string; isNew: boolean; at: string }

// Orchestrates check/pull: preflight → OCI pull/extract → fixup (version detect + marker) →
// validation gate (injected) → auto-activate → recompose pg_distrib. One pull runs at a time
// globally (private `pulling` mutex); `pull()` inserts the `downloading` row synchronously and
// returns its buildId — REST/MCP callers can poll `GET /api/pg-builds` (or the pg_builds event)
// for that id immediately, same shape as every other long daemon operation. Build identity is
// the image DIGEST (row + dir are digest-addressed, `v{major}/{shortDigest}`); the tag is
// metadata recording what was asked for — re-pulling a mutable tag at a new digest installs a
// NEW build beside the old one.
export class Provisioner {
  private pulling = false;
  private lastCheck = new Map<number, CheckResult>();

  constructor(private deps: {
    registry: BuildRegistry; oci: OciPuller; state: StateDb; logs: LogsService;
    events: EventsService | undefined;
    // gateTimeoutMs: test-only override of the 90s validation-gate budget (production wiring in
    // index.ts leaves it unset) — the timeout path is otherwise untestable without faking timers
    // around the pipeline's real fs work.
    cfg: { pgBuildsDir: string; pgImageTemplate: string; gateTimeoutMs?: number };
    // Fix 3 (task-9 gate integration): validate receives an AbortSignal the Provisioner aborts
    // when the gate budget expires — see the gate block in extractFixupAndGate below.
    validate: (a: { major: number; buildPath: string; signal?: AbortSignal }) => Promise<void>;
    detectVersion: (pgbin: string) => Promise<{ major: number; minor: number }>;
    du: (dir: string) => Promise<number | null>;
    statfsFree: (dir: string) => Promise<number>;
    recomposeDistrib: () => Promise<void>;
    logger: { info(m: string): void; error(m: string, e?: unknown): void };
  }) {}

  repoFor(major: number): string {
    return this.deps.cfg.pgImageTemplate.replace("{major}", String(major));
  }

  // Resolves each major's `latest` digest against the registry and records whether it's new
  // (i.e. not already present as a `pg_builds` row) — the UI's "update available" check.
  async check(majors: number[]): Promise<Record<string, CheckResult>> {
    const out: Record<string, CheckResult> = {};
    for (const major of majors) {
      const { digest } = await this.deps.oci.resolveDigest(this.repoFor(major), "latest");
      // byDigest is intentionally ready-preferred: absent a ready row, it returns a failed one
      // instead (so pull() can retry). That makes a bare "found a row" check wrong here — a row
      // that failed at this exact digest is NOT installed, so only a ready row counts.
      const isNew = this.deps.state.pgBuilds.byDigest(digest)?.status !== "ready";
      const result: CheckResult = { tag: "latest", digest, isNew, at: new Date().toISOString() };
      this.lastCheck.set(major, result);
      out[String(major)] = result;
    }
    return out;
  }

  // The UI badge string for a major's last check(): "latest@<12-char digest>" only when that
  // check found something not yet installed; null otherwise (nothing new, or never checked).
  updateAvailableFor(major: number): string | null {
    const c = this.lastCheck.get(major);
    if (!c || !c.isNew) return null;
    return `latest@${c.digest.replace(/^sha256:/, "").slice(0, 12)}`;
  }

  private publish(): void {
    this.deps.events?.publish({ type: "pg_builds" });
  }

  private log(buildId: string, line: string): void {
    this.deps.logs.ingest(`pgbuild:${buildId}`, line);
  }

  // Kicks off an async pull job and returns its buildId immediately (202-style). Only one pull
  // may run at a time process-wide; a concurrent call rejects with a generic 409 rather than
  // queuing — the caller (human or agent) retries once the first finishes.
  async pull(a: { major: number; tag?: string }): Promise<{ buildId: string }> {
    if (a.tag !== undefined && !OCI_TAG_RE.test(a.tag)) {
      throw new DevdbError(400, `invalid tag: ${a.tag}`);
    }
    if (this.pulling) {
      throw new DevdbError(409, "a build pull is already in progress");
    }
    const id = crypto.randomUUID();
    const tag = a.tag ?? "latest";
    // Contract: the `downloading` row exists BEFORE pull() returns, so an immediate byId(buildId)
    // poll always finds it. Digest and path are unknown until resolveDigest runs — the '' digest
    // sentinel is excluded from byDigest() dedup lookups, and the pipeline fills both in via
    // setDigestPath. (No await sits between the mutex check and the flag set, and the flag is set
    // only after the insert succeeded, so a synchronous insert failure cannot latch the mutex.)
    this.deps.state.pgBuilds.insert({
      id, major: a.major, source: "downloaded", releaseTag: tag, imageDigest: "", path: "",
      status: "downloading",
    });
    this.pulling = true;
    this.publish();
    // Fire-and-forget: the pipeline runs after this method returns. Errors inside runPipeline
    // are always caught and recorded on the row itself (never surfaced as an unhandled rejection).
    void this.runPipeline(id, a.major, tag).finally(() => { this.pulling = false; });
    return { buildId: id };
  }

  private async runPipeline(id: string, major: number, tag: string): Promise<void> {
    const { deps } = this;
    const { state } = deps;
    const repo = this.repoFor(major);
    let jobStatus: "done" | "failed" = "failed";
    // Populated by extractFixupAndGate the instant the tmp dir is renamed into place — i.e. only
    // once a real, on-disk finalDir exists. Stays unset for any failure before that point
    // (preflight/resolveDigest/extract/detectVersion-mismatch), so the outer catch below never
    // tries to rm a ""/undefined path.
    const finalDirRef: { current: string | undefined } = { current: undefined };
    // Fix round 1 (compensation gaps, review of Task 8 commit 43ce4b7): flipped true the instant
    // registry.activate(id) succeeds (extractFixupAndGate below). activate() unconditionally
    // clears the major's previously-active row before setting the new one — so a failure AFTER
    // that point (recomposeDistrib throwing, currently the only step left) must re-resolve the
    // major's active pointer in the outer catch, or the major is left with NO active ready build
    // (the old one cleared, the new one about to be marked failed) until the next boot.
    const activatedRef: { current: boolean } = { current: false };
    try {
      // --- Preflight: disk headroom, BEFORE any network. The row (inserted by pull()) still
      // carries the '' digest sentinel here — same sentinel baked rows use, and byDigest()
      // already excludes '' from dedup lookups.
      const free = await deps.statfsFree(deps.cfg.pgBuildsDir);
      if (free < MIN_FREE_BYTES) {
        state.pgBuilds.setStatus(id, "failed", "insufficient disk space on /data (< 1.5 GB free)");
        this.log(id, "preflight failed: insufficient disk space on /data (< 1.5 GB free)");
        this.publish();
        return;
      }

      // --- Dedup: resolve the digest, then check whether it's already installed & ready.
      // Identity is the DIGEST, never the tag: a mutable tag (`latest`) re-pulled at a new digest
      // is a NEW build (this row proceeds; the old digest's row and dir persist until GC), while
      // the same digest already ready — whatever tag it arrived under — is a no-op. The no-op row
      // keeps the '' digest sentinel so it can never shadow the real install in byDigest().
      const { digest } = await deps.oci.resolveDigest(repo, tag);
      const existing = state.pgBuilds.byDigest(digest);
      if (existing && existing.status === "ready") {
        const versionStr = existing.minor !== null ? `${existing.major}.${existing.minor}` : `${existing.major}.x`;
        const msg = `already installed as ${versionStr} — no-op`;
        state.pgBuilds.setStatus(id, "failed", msg);
        this.log(id, msg);
        this.publish();
        return;
      }

      // Row now enters the real pipeline: digest + content-addressed extraction path are known.
      const tmpDir = join(deps.cfg.pgBuildsDir, `v${major}`, `.tmp-${shortDigest(digest)}`);
      state.pgBuilds.setDigestPath(id, { imageDigest: digest, path: tmpDir });
      this.publish();

      // --- jobs bookkeeping (write-only this phase; a jobs REST API is phase 4's contract).
      const jobId = crypto.randomUUID();
      state.raw.prepare("INSERT INTO jobs (id, kind, status) VALUES (?, 'pg_build_pull', 'running')").run(jobId);
      try {
        await this.extractFixupAndGate(id, major, tag, digest, tmpDir, finalDirRef, activatedRef);
        jobStatus = state.pgBuilds.byId(id)?.status === "ready" ? "done" : "failed";
      } finally {
        state.raw.prepare("UPDATE jobs SET status = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
          .run(jobStatus, jobId);
      }
    } catch (err) {
      // Any uncaught failure anywhere above (statfsFree/resolveDigest/extract/gate machinery/a
      // non-downgrade activate error) lands here. The row always exists — pull() inserted it
      // before the pipeline started — so record the failure on it.
      state.pgBuilds.setStatus(id, "failed", firstLine(err));
      this.log(id, `pull failed: ${firstLine(err)}`);
      deps.logger.error(`pg_build ${id} pull failed`, err);
      this.publish();
      // A throw reaching here from PAST the rename (a non-409 activate malfunction, or
      // recomposeDistrib throwing) leaves a fully-extracted finalDir on disk with the row marked
      // failed. Clean it up — mirrors the gate-failure rm below — so byDigest's ready-preference
      // (which happily returns this failed row) doesn't let a same-digest retry through only to
      // have its rename(tmpDir, finalDir) fail ENOTEMPTY against the leftover dir.
      if (finalDirRef.current !== undefined) {
        await rm(finalDirRef.current, { recursive: true, force: true }).catch(() => {});
      }
      // Fix round 1 (compensation gaps): a failure reaching here AFTER activate(id) already
      // succeeded means the major's previously-active row was cleared (by activate()) but the new
      // row — now marked failed above — never gets to serve as the replacement. Without this, the
      // major has NO active ready build until the next boot's resolveActives() call. Re-resolving
      // here re-picks the newest ready build per major (excluding the row just marked failed),
      // restoring whatever was active before (e.g. the older/baked build) immediately, not just at
      // next boot. Harmless to call when activation never happened (nothing to restore, but a
      // resolve is a correct no-op re-affirmation of the untouched active pointer).
      if (activatedRef.current) {
        this.deps.registry.resolveActives();
      }
    }
  }

  // Steps 3-6 of the pipeline: extract, fixup+marker, validation gate, activate. Split out of
  // runPipeline so the outer try/catch there is the single place that guarantees a row never gets
  // stuck in "downloading"/"validating" on an unexpected throw.
  private async extractFixupAndGate(
    id: string, major: number, tag: string, digest: string, tmpDir: string,
    finalDirRef: { current: string | undefined }, activatedRef: { current: boolean },
  ): Promise<void> {
    const { deps } = this;
    const { state } = deps;
    const repo = this.repoFor(major);

    // --- Extract.
    await deps.oci.pullPrefix({
      repository: repo, digest, destDir: tmpDir, prefix: "usr/local/",
      onProgress: (line) => this.log(id, line),
    });

    // --- Fixup: version detect, must match the requested major.
    const { major: detectedMajor, minor } = await deps.detectVersion(join(tmpDir, "bin", "postgres"));
    if (detectedMajor !== major) {
      const msg = `image contained postgres ${detectedMajor}.${minor}, expected major ${major}`;
      await rm(tmpDir, { recursive: true, force: true });
      state.pgBuilds.setStatus(id, "failed", msg);
      this.log(id, msg);
      this.publish();
      return;
    }

    const extractedAt = new Date().toISOString();
    await writeFile(join(tmpDir, "build.json"), JSON.stringify({ digest, tag, major, minor, extractedAt }));
    const sizeBytes = await deps.du(tmpDir);

    // Content-addressed final home: the digest, not the tag, names the dir — two pulls of the
    // same mutable tag at different digests coexist side by side.
    const finalDir = join(deps.cfg.pgBuildsDir, `v${major}`, shortDigest(digest));
    await rename(tmpDir, finalDir);
    finalDirRef.current = finalDir; // from here on, a throw reaching runPipeline's catch must rm it
    state.pgBuilds.updatePath(id, finalDir);
    state.pgBuilds.setDetected(id, { minor, sizeBytes });
    state.pgBuilds.setStatus(id, "validating");
    this.log(id, `extracted postgres ${major}.${minor} — validating`);
    this.publish();

    // --- Gate: injected validate(), 90s budget. Fix 3 (task-9 gate integration): the budget is
    // enforced with an ABORT, not just a Promise.race — before this fix, when the timeout won the
    // race the losing validate() kept running with nobody listening, and its own cleanup (the
    // runner's finally: delete the `_devdb_validate_` project) only ran once the hung step's own
    // timeout finally settled it (readyTimeout ~50s / query_timeout ~35s), leaving the gate
    // project/branch/compute alive well past the pull's recorded failure (the boot sweep being
    // only an eventual backstop). Aborting the signal makes the runner short-circuit its
    // remaining steps, stop the endpoint, and delete the gate project promptly — abort() is
    // called BEFORE reject() so cleanup is already in motion when the pipeline records failure.
    const gateTimeoutMs = deps.cfg.gateTimeoutMs ?? GATE_TIMEOUT_MS;
    const gateAbort = new AbortController();
    let gateTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        deps.validate({ major, buildPath: finalDir, signal: gateAbort.signal }),
        new Promise<never>((_, reject) => {
          gateTimer = setTimeout(() => {
            const err = new Error(`gate timed out after ${gateTimeoutMs / 1000}s`);
            gateAbort.abort(err);
            reject(err);
          }, gateTimeoutMs);
        }),
      ]);
    } catch (err) {
      await rm(finalDir, { recursive: true, force: true }); // no 250 MB corpses
      const msg = firstLine(err);
      state.pgBuilds.setStatus(id, "failed", msg);
      this.log(id, `validation gate failed: ${msg}`);
      this.publish();
      return; // active pointer untouched
    } finally {
      // Runs whether validate won, threw, or timed out: never leave the (up to 90s) timer pending
      // after the gate settled — it would otherwise keep firing a stale abort/rejection later.
      clearTimeout(gateTimer);
    }

    state.pgBuilds.setStatus(id, "ready");
    this.log(id, `validation gate passed — ${major}.${minor} ready`);
    this.publish();

    // --- Activate: a validated pull auto-activates. A fresh pull is never a downgrade in the
    // ordinary case, but re-pulling an old tag deliberately can be — ONLY that 409 is expected
    // and left as a ready-but-inactive build (not a pipeline failure). Anything else (a genuine
    // activation malfunction) must propagate to the outer pipeline catch, which marks the row
    // and the job failed.
    try {
      this.deps.registry.activate(id);
      activatedRef.current = true; // from here on, a throw reaching runPipeline's catch must resolveActives()
      this.log(id, `activated ${major}.${minor}`);
    } catch (err) {
      if (err instanceof DevdbError && err.statusCode === 409) {
        this.log(id, `${firstLine(err)} — call activate to make ${major}.${minor} the running build`);
      } else {
        throw err;
      }
    }

    await deps.recomposeDistrib(); // covers the new-major case (no baked slot existed before)
    this.publish();
  }

  // Deletes a build (registry.assertRemovable guards active/baked/in-use rows).
  async remove(id: string, runningPgbins: string[]): Promise<void> {
    const row: PgBuildRow = this.deps.registry.assertRemovable(id, runningPgbins);
    await rm(row.path, { recursive: true, force: true });
    this.deps.state.pgBuilds.delete(id);
    await this.deps.recomposeDistrib();
    this.publish();
  }
}
