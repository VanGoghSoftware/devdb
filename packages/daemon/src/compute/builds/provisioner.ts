import { execFile } from "node:child_process";
import { rename, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DevdbError } from "../../services/errors.js";
import type { StateDb } from "../../state/db.js";
import type { PgBuildRow } from "../../state/repos.js";
import type { BuildRegistry } from "./registry.js";
import type { OciPuller } from "./oci.js";
import type { LogsService } from "../../services/logs.js";
import type { EventsService } from "../../services/events.js";

const execFileP = promisify(execFile);

const MIN_FREE_BYTES = 1.5 * 2 ** 30;
const GATE_TIMEOUT_MS = 90_000;

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
// globally (private `pulling` mutex); `pull()` itself returns as soon as the job is queued —
// REST/MCP callers get a buildId immediately and poll `GET /api/pg-builds` (or the pg_builds
// event) for completion, same shape as every other long daemon operation.
export class Provisioner {
  private pulling = false;
  private lastCheck = new Map<number, CheckResult>();

  constructor(private deps: {
    registry: BuildRegistry; oci: OciPuller; state: StateDb; logs: LogsService;
    events: EventsService | undefined;
    cfg: { pgBuildsDir: string; pgImageTemplate: string };
    validate: (a: { major: number; buildPath: string }) => Promise<void>;
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
      const isNew = this.deps.state.pgBuilds.byDigest(digest) === null;
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
    if (this.pulling) {
      throw new DevdbError(409, "a build pull is already in progress");
    }
    this.pulling = true;
    const id = crypto.randomUUID();
    const tag = a.tag ?? "latest";
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
    try {
      // --- Preflight: disk headroom, BEFORE any network. No digest is known yet at this point,
      // so a preflight-failed row is inserted with an empty (unresolved) imageDigest sentinel —
      // same sentinel baked rows use, and byDigest() already excludes '' from dedup lookups.
      const free = await deps.statfsFree(deps.cfg.pgBuildsDir);
      if (free < MIN_FREE_BYTES) {
        state.pgBuilds.insert({
          id, major, source: "downloaded", releaseTag: tag, imageDigest: "",
          path: join(deps.cfg.pgBuildsDir, `v${major}`, `.tmp-${tag}`), status: "failed",
        });
        state.pgBuilds.setStatus(id, "failed", "insufficient disk space on /data (< 1.5 GB free)");
        this.log(id, "preflight failed: insufficient disk space on /data (< 1.5 GB free)");
        this.publish();
        return;
      }

      // --- Dedup: resolve the digest, then check whether it's already installed & ready.
      const { digest } = await deps.oci.resolveDigest(repo, tag);
      const tmpDir = join(deps.cfg.pgBuildsDir, `v${major}`, `.tmp-${tag}`);
      const existing = state.pgBuilds.byDigest(digest);
      if (existing && existing.status === "ready") {
        state.pgBuilds.insert({
          id, major, source: "downloaded", releaseTag: tag, imageDigest: digest,
          path: tmpDir, status: "failed",
        });
        const versionStr = existing.minor !== null ? `${existing.major}.${existing.minor}` : `${existing.major}.x`;
        const msg = `already installed as ${versionStr} — no-op`;
        state.pgBuilds.setStatus(id, "failed", msg);
        this.log(id, msg);
        this.publish();
        return;
      }

      // Row now enters the real pipeline: downloading.
      state.pgBuilds.insert({
        id, major, source: "downloaded", releaseTag: tag, imageDigest: digest,
        path: tmpDir, status: "downloading",
      });
      this.publish();

      // --- jobs bookkeeping (write-only this phase; a jobs REST API is phase 4's contract).
      const jobId = crypto.randomUUID();
      state.raw.prepare("INSERT INTO jobs (id, kind, status) VALUES (?, 'pg_build_pull', 'running')").run(jobId);
      try {
        await this.extractFixupAndGate(id, major, tag, digest, tmpDir);
        jobStatus = state.pgBuilds.byId(id)?.status === "ready" ? "done" : "failed";
      } finally {
        state.raw.prepare("UPDATE jobs SET status = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
          .run(jobStatus, jobId);
      }
    } catch (err) {
      // Any uncaught failure anywhere above (preflight/resolveDigest/insert) still needs recording
      // if a row wasn't already written — but every branch above already writes+returns on its own
      // failure path, so reaching here means resolveDigest (or an insert) itself threw. Best-effort
      // record it on the id if no row exists yet.
      if (!state.pgBuilds.byId(id)) {
        try {
          state.pgBuilds.insert({
            id, major, source: "downloaded", releaseTag: tag, imageDigest: "",
            path: join(deps.cfg.pgBuildsDir, `v${major}`, `.tmp-${tag}`), status: "failed",
          });
        } catch {
          // insert itself failing here means the id is somehow already taken — nothing more we
          // can do; the error is still logged below.
        }
      }
      state.pgBuilds.setStatus(id, "failed", firstLine(err));
      this.log(id, `pull failed: ${firstLine(err)}`);
      deps.logger.error(`pg_build ${id} pull failed`, err);
      this.publish();
    }
  }

  // Steps 3-6 of the pipeline: extract, fixup+marker, validation gate, activate. Split out of
  // runPipeline so the outer try/catch there is the single place that guarantees a row never gets
  // stuck in "downloading"/"validating" on an unexpected throw.
  private async extractFixupAndGate(
    id: string, major: number, tag: string, digest: string, tmpDir: string,
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

    const finalDir = join(deps.cfg.pgBuildsDir, `v${major}`, tag);
    await rename(tmpDir, finalDir);
    state.pgBuilds.updatePath(id, finalDir);
    state.pgBuilds.setDetected(id, { minor, sizeBytes });
    state.pgBuilds.setStatus(id, "validating");
    this.log(id, `extracted postgres ${major}.${minor} — validating`);
    this.publish();

    // --- Gate: injected validate(), 90s budget.
    try {
      await Promise.race([
        deps.validate({ major, buildPath: finalDir }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`gate timed out after ${GATE_TIMEOUT_MS / 1000}s`)), GATE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      await rm(finalDir, { recursive: true, force: true }); // no 250 MB corpses
      const msg = firstLine(err);
      state.pgBuilds.setStatus(id, "failed", msg);
      this.log(id, `validation gate failed: ${msg}`);
      this.publish();
      return; // active pointer untouched
    }

    state.pgBuilds.setStatus(id, "ready");
    this.log(id, `validation gate passed — ${major}.${minor} ready`);
    this.publish();

    // --- Activate: a validated pull auto-activates. A fresh pull is never a downgrade in the
    // ordinary case, but re-pulling an old tag deliberately can be — that 409 is expected and
    // left as a ready-but-inactive build (not a pipeline failure).
    try {
      this.deps.registry.activate(id);
      this.log(id, `activated ${major}.${minor}`);
    } catch (err) {
      this.log(id, `${firstLine(err)} — call activate to make ${major}.${minor} the running build`);
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
