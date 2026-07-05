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

  // Fix round 1 (review of Task 10 commit 3bfc859, Fix #2, P3): a simple promise-chain
  // serializer for build state-MUTATIONS (activate/remove, and the pull pipeline's own
  // auto-activate step) — distinct from `pulling` above, which only single-flights the
  // download/extract/gate portion of a pull. Without this lane, `remove(id)` (assertRemovable
  // synchronously, then `await rm(row.path)`) could race a concurrent `activate(id)` for the
  // same row during that await: activate flips the row active + recomposes, then the in-flight
  // remove deletes it anyway — the row vanishes from disk AND SQLite while having been "active"
  // an instant earlier, stranding the major with no ready build until the next GC/reboot re-
  // resolves one. Reachable in the agents-first design: two MCP clients, or an agent + the web
  // UI, hitting activate/delete for the same build concurrently.
  //
  // Deliberately NOT used for the pull pipeline's download/extract/gate (only its final
  // auto-activate step, see extractFixupAndGate below) — a long-running pull must not block an
  // unrelated activate/delete for minutes; only the brief moment where the active pointer
  // actually flips needs mutual exclusion with other such flips.
  //
  // `mutationTail` is deliberately never allowed to become a REJECTED promise — a rejected tail
  // chained onto would skip every subsequent `.then(fn)` (its `fn` never runs on a rejected
  // parent), permanently jamming the lane after the first failing mutation. Each call's `result`
  // (the real value/rejection this call's OWN caller sees, via the returned promise) is tracked
  // separately from what gets stored back into `mutationTail`: the stored continuation always
  // resolves — via `.then(noop, noop)` — regardless of whether `fn()` succeeded or threw.
  private mutationTail: Promise<unknown> = Promise.resolve();

  private runMutation<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(fn);
    this.mutationTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

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
    // that point must re-resolve the major's active pointer in the outer catch, or the major is
    // left with NO active ready build (the old one cleared, the new one about to be marked
    // failed) until the next boot. HARD-2 (hardening pass) made the one step that used to throw
    // there — recomposeDistrib — non-throwing at its call site (a post-gate recompose failure
    // keeps the build; see extractFixupAndGate), and log()/publish() swallow by contract, so the
    // catch's activatedRef branch is now an unreachable-in-practice BACKSTOP, kept for any
    // future throwing step added between activation and the end of the lane body.
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
      // before the pipeline started — so record the failure on it. The status flip + logging are
      // deliberately IMMEDIATE (not lane-gated): they are non-destructive, and failing the row as
      // early as possible means a concurrent laned activate(id) 409s ("not ready") rather than
      // committing to a row whose teardown is already queued.
      state.pgBuilds.setStatus(id, "failed", firstLine(err));
      this.log(id, `pull failed: ${firstLine(err)}`);
      deps.logger.error(`pg_build ${id} pull failed`, err);
      this.publish();
      // Destructive + pointer compensation for a failure PAST the rename. Post-HARD-2 that means
      // a non-409 activate() malfunction or a post-rename SQLite/fs throw (including the gate
      // catch's own rm failing) — a recomposeDistrib failure no longer lands here (swallowed at
      // its call site in extractFixupAndGate: the build is valid and KEPT). For what still does:
      //  - rm the fully-extracted finalDir (mirrors the gate-failure rm below) so byDigest's
      //    ready-preference (which happily returns this failed row) doesn't let a same-digest
      //    retry through only to have its rename(tmpDir, finalDir) fail ENOTEMPTY;
      //  - FIX-3(a) (final review): clear the row's stored path right after — a failed row must
      //    not keep claiming a digest dir a successful same-digest retry will re-create, or a
      //    later DELETE of the failed row would rm the retry's live directory (see remove());
      //  - restore the major's active pointer if the failed auto-activate stranded it.
      //
      // FIX-3 / Fable Minor #5 (final review): the WHOLE compensation — not just the pointer
      // recovery — runs INSIDE the mutation lane. The rm used to run un-laned here, so it could
      // microtask-interleave with a concurrent laned activate() mid-body (between its
      // registry.activate and its recomposeDistrib), deleting the very directory that activation
      // was committing to. Laned, it strictly follows any in-flight activate/remove instead.
      //
      // Fix round 2 (review of the round-1 recovery) still applies to the pointer half — it is a
      // GUARDED, MAJOR-SCOPED gap-filler, not the un-laned global resolveActives() it once was:
      //  - guarded: if a concurrent laned mutation already left this major with an active ready
      //    build, that IS a sane state — leave it. An unconditional re-pick would silently
      //    override a deliberate non-newest activation that won the lane.
      //  - scoped: resolveActiveFor(major) re-resolves ONLY the major this pipeline broke (and
      //    FIX-1: re-derives its degraded flag). The global resolveActives() also re-picked every
      //    OTHER major, silently re-upgrading an explicitly-pinned one on this pull's failure.
      // Errors are logged, never rethrown: this pipeline's promise is void'd in pull() (fire-and-
      // forget), so a throw escaping here would be an unhandled rejection, breaking pull()'s
      // contract that a failure only ever lands on the row.
      //
      // Deliberately does NOT re-run recomposeDistrib() (as the pre-fix global resolveActives()
      // also didn't): a failure that lands here is likely environmental (SQLite/disk), so a
      // recompose attempt would most likely fail too. The pg_distrib farm self-heals per
      // activate()'s doc below —
      // composePgDistrib re-derives from the registry on every call and boot recomposes before
      // engine.start(); baked-backed majors are unaffected regardless (baked always wins its slot).
      if (finalDirRef.current !== undefined || activatedRef.current) {
        await this.runMutation(async () => {
          if (finalDirRef.current !== undefined) {
            await rm(finalDirRef.current, { recursive: true, force: true }).catch(() => {});
            state.pgBuilds.updatePath(id, "");
          }
          if (activatedRef.current) {
            const hasActiveReady = state.pgBuilds.listByMajor(major)
              .some((r) => r.active && r.status === "ready");
            if (!hasActiveReady) {
              this.deps.registry.resolveActiveFor(major);
            }
          }
          this.publish();
        }).catch((e) => deps.logger.error(`pg_build ${id}: post-failure compensation failed`, e));
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
      state.pgBuilds.updatePath(id, ""); // FIX-3(a): failure-rm'd the dir ⇒ drop the row's claim on it
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
      // FIX-3(a) (final review): the failed row must not keep claiming the digest-named dir. A
      // successful retry of the SAME image re-creates that exact dir (identity is the digest), and
      // a later DELETE of this failed row would then rm the retry's live directory out from under
      // the active build. Cleared here (and in the outer catch / mismatch branch above), an
      // empty path is the normal terminal state of a failure-rm'd row — FIX-4's guards treat it
      // as never-in-use. No lane needed for THIS rm: the row is still `validating`, so no
      // activate/remove can be operating on it, and a concurrent remove of a same-path SIBLING
      // row skips its rm while this row still claims the path (remove()'s FIX-3(b) check).
      state.pgBuilds.updatePath(id, "");
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
    //
    // Fix round 1 (Fix #2, P3 — mutation lane): this step (activate + recompose), NOT the
    // download/extract/gate above it, runs inside runMutation — the same lane an explicit
    // POST .../activate or DELETE serializes through. Without this, a concurrent explicit
    // activate()/remove() for a DIFFERENT build of this row's major could interleave with this
    // auto-activate flipping the just-finished pull's row active, corrupting whichever active
    // pointer/on-disk state loses the race. The long-running work above (network pull, extract,
    // 90s validation gate) is deliberately OUTSIDE the lane so it never blocks an unrelated
    // activate/delete for its full duration — only this brief active-pointer flip needs mutual
    // exclusion with other such flips.
    await this.runMutation(async () => {
      try {
        this.deps.registry.activate(id);
        activatedRef.current = true; // a throw reaching runPipeline's catch past this point must re-resolve the pointer
        this.log(id, `activated ${major}.${minor}`);
      } catch (err) {
        if (err instanceof DevdbError && err.statusCode === 409) {
          this.log(id, `${firstLine(err)} — call activate to make ${major}.${minor} the running build`);
        } else {
          throw err;
        }
      }
      // HARD-2 (hardening pass, P2): recomposeDistrib runs strictly AFTER the build is final —
      // the row reached `ready` (gate passed) and the activation outcome above is committed
      // (either the pointer flipped, or a downgrade 409 deliberately left it ready-but-inactive;
      // registry.activate throws its 409s before mutating anything). From here the BUILD can no
      // longer be wrong; only the pg_distrib farm can — and the farm is the self-healing part
      // (composePgDistrib re-derives it from the registry on every call, and boot recomposes
      // before engine.start; see activate()'s Fix #1 note below, which accepts this exact
      // failure for EXPLICIT activation). Letting the throw reach runPipeline's outer catch used
      // to DESTROY the valid build: setStatus(failed) + rm finalDir + path-clear + pointer
      // re-resolve — a transient ENOSPC during the symlink-farm rebuild reverted the major to an
      // older build, and if an endpoint had started on this build in the activate→recompose
      // window (pgbinFor is not serialized with this lane), the rm deleted a live compute's
      // --pgbin dir out from under it. So: swallow HERE, at the one call whose failure is
      // recoverable-by-design, and log loudly. A non-409 registry.activate() malfunction above
      // still propagates — that row's fate is genuinely unknown, and the outer catch's
      // fail + rm + compensate contract remains exactly right for it.
      try {
        await deps.recomposeDistrib(); // covers the new-major case (no baked slot existed before)
      } catch (err) {
        this.log(id, `pg_distrib recompose failed — build stays ready: ${firstLine(err)}`);
        deps.logger.error(
          `pg_build ${id}: pg_distrib recompose failed after ${major}.${minor} passed the gate — `
          + "build left ready; the farm self-heals on the next recompose or boot", err);
      }
    });
    this.publish();
  }

  // Explicit activation (e.g. picking an older build from the UI, or clearing a degraded-
  // downgrade flag with consent). Task 10's REST route originally called registry.activate() +
  // recomposeDistrib() + events.publish() directly, un-serialized with remove() below — Fix
  // round 1 (Fix #2, P3) moves that whole sequence here, inside runMutation, so the two can
  // never interleave for the same (or a related) row. registry.activate() itself stays pure
  // registry/SQLite bookkeeping (no opinion on pg_distrib) — recomposeDistrib() still runs right
  // after, same as it always has.
  //
  // Fix round 1 (Fix #1, documentation only — no behavior change): a recomposeDistrib() failure
  // here leaves the active pointer committed (registry.activate() already returned) but the
  // pg_distrib symlink farm stale. This is DELIBERATELY accepted as recoverable/self-healing, not
  // an unexamined gap: composePgDistrib fully re-derives the farm from registry.list() on every
  // call, and index.ts recomposes it at every boot before engine.start() — so the only exposure
  // is a downloaded-only NEW major's walredo until the next successful recompose (a pull's own
  // auto-activate above, another activate/remove, or the next boot). A rollback here would be
  // wrong for the common case (a minor refresh where the new build is immediately usable) — this
  // is a conscious tradeoff, not a missed one.
  async activate(id: string, opts?: { consented?: boolean }): Promise<PgBuildRow> {
    return this.runMutation(async () => {
      const row = this.deps.registry.activate(id, opts);
      await this.deps.recomposeDistrib();
      this.publish();
      return row;
    });
  }

  // Deletes a build (registry.assertRemovable guards active/baked/in-use rows). Fix round 1
  // (Fix #2, P3): the whole body now runs inside runMutation — assertRemovable's synchronous
  // "is this row safe to remove right now" check and the `await rm(row.path)` that follows it
  // must not have a concurrent activate() for the same row observe/flip the row in between (see
  // this class's own runMutation doc comment for the exact race this closes).
  //
  // HARD-1 (hardening pass, P2): `runningPgbins` is a SUPPLIER invoked INSIDE the lane body,
  // immediately before assertRemovable — not an array captured by the caller. The DELETE route
  // used to snapshot computes.runningPgbins() before remove() had even queued; every other fact
  // assertRemovable consults (active/baked/status) is read live from the row at removal time,
  // but the in-use check consumed that frozen snapshot — so a build an endpoint started on WHILE
  // the DELETE waited out an in-flight laned activate/remove was still judged "not in use" and
  // its dir rm'd out from under the running compute (ENOENT on the live --pgbin). Reading the
  // supplier inside the lane makes the in-use check exactly as live as the row checks. Endpoint
  // starts are NOT serialized with this lane, yet the endpoint-vs-build-lane rm race is CLOSED
  // (post-merge concurrency review, 2026-07-05 — controller analysis + review-broker adversarial
  // scan found no reachable interleaving): a start "landing after the supplier read but before the
  // rm" cannot land on THIS row, because remove() only reaches here for a NON-active build
  // (assertRemovable rejects the active one), pgbinFor() only ever returns the ACTIVE build, and
  // the pgbinFor→computes.start→runningPgbins span is synchronous (no yield) — so any endpoint that
  // ever committed to this build had it in runningPgbins() before it could go non-active and thus
  // removable. The closure rests on that span staying synchronous: documented load-bearing at
  // endpoints.startLocked() + ComputeManager.start(), pinned by endpoints-service.test.ts (the
  // startLocked no-await span) + manager.test.ts (the ComputeManager reservation). Not a
  // lane-coupling or a build-dir refcount — neither is needed.
  //
  // FIX-3(b) (final review): the rm runs only when this row is the SOLE claimant of a non-empty
  // path. Rows legitimately share a path — a gate-failed attempt and its successful retry of the
  // same image share a digest and therefore the digest-named dir (state/repos.ts byDigest doc) —
  // and assertRemovable checks the ROW, never whether a sibling still claims the directory.
  // Without this, DELETE of an old failed attempt rm'd the READY, ACTIVE build's dir out from
  // under it (endpoint starts ENOENT until the next boot re-failed it). The ROW is deleted
  // regardless — belt-and-suspenders with FIX-3(a)'s path-clear on every failure rm.
  async remove(id: string, runningPgbins: () => string[]): Promise<void> {
    await this.runMutation(async () => {
      const row: PgBuildRow = this.deps.registry.assertRemovable(id, runningPgbins());
      const siblingClaimsPath = this.deps.state.pgBuilds.list()
        .some((r) => r.id !== id && r.path === row.path);
      if (row.path !== "" && !siblingClaimsPath) {
        await rm(row.path, { recursive: true, force: true });
      }
      this.deps.state.pgBuilds.delete(id);
      await this.deps.recomposeDistrib();
      this.publish();
    });
  }
}
