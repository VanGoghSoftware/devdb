import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EndpointStatus, PgVersion } from "@devdb/shared";
import type { DevdbConfig } from "../config.js";
import type { BranchRow } from "../state/repos.js";
import type { Logger } from "../logging/logger.js";
import { engineDirs } from "../engine/configs.js";
import { ManagedProcess } from "../engine/process.js";
import { computeConfigJson } from "./spec.js";
import { PG_HBA } from "./pgconf.js";
import { allocatePort, type PortProbe } from "./ports.js";
import { waitComputeReady } from "./readiness.js";

interface RunningCompute {
  proc: ManagedProcess | null;
  port: number | null;
  metricsPort: number | null;
  internalHttpPort: number | null;
  dir: string | null;
  listeners: Array<(line: string) => void>;
  phase: "starting" | "running" | "stopping";
  // Task 8: the caller-resolved --pgbin path this entry was (or is being) launched with — set in
  // the SAME synchronous reservation tick as the other entry fields below, before the first
  // await, so a concurrent runningPgbin() call can never observe a half-started entry missing it.
  pgbinPath: string | null;
}

export class ComputeManager {
  private computes = new Map<string, RunningCompute>();
  private reservedPorts = new Set<number>();

  // `waitComputeReady` is an injected 3rd (optional) positional dependency — defaulting to the
  // real poller — rather than a hardcoded call, so unit tests that exercise the real start()
  // (manager.test.ts mocks ManagedProcess but not this) never hit the global `fetch`: they pass a
  // fast-resolving fake here instead. Kept positional (not folded into a deps bag) to match this
  // class's existing (cfg, logger) constructor shape rather than introduce a second pattern.
  constructor(
    private cfg: DevdbConfig,
    private logger: Logger,
    private waitReady: typeof waitComputeReady = waitComputeReady,
    // Task 3 (phase 3): announces "statusOf(branchId) may have changed" — index.ts forwards this
    // to /api/events as an `endpoint.status` invalidation hint. Coarse by design: over-firing is
    // harmless (events are hints, not payloads), missing a transition is not. Kept optional and
    // positional (like waitReady above) so every existing construction in this file's tests, which
    // predate this arg, stays valid untouched.
    private onStatusChange?: (branchId: string) => void,
    // Injectable bind probe, forwarded verbatim to every allocatePort() call below. Undefined in
    // production (index.ts constructs without it) so allocatePort falls back to its real tryBind
    // default; unit tests pass a fake so port allocation never binds a real socket. The real probe
    // binds 127.0.0.1:<candidate>, and docker-proxy holds every port across the published
    // DEVDB_PORT_RANGE (54300-54339, the default) whenever the compose container is up — so a
    // real-probe start() in a unit test exhausts the range and throws PortExhaustedError with the
    // product running. Positional and optional, matching waitReady/onStatusChange above rather than
    // introducing a deps bag. Real tryBind behaviour stays covered in ports.test.ts.
    private probe?: PortProbe,
  ) {}

  private notifyStatus(branchId: string): void {
    try {
      this.onStatusChange?.(branchId);
    } catch {
      // observer must never break the compute lifecycle — swallow, same contract as onLine fanout.
    }
  }

  statusOf(branchId: string): EndpointStatus {
    const c = this.computes.get(branchId);
    if (!c) return "stopped";
    if (c.phase === "stopping") return "stopping";
    if (!c.proc) return "starting";
    // Readiness window: the needle has fired (proc.state "running") but apply_spec/SCRAM has not
    // committed. Do NOT expose "running" (detail() would hand out a connection string into the
    // first-start auth race). A crash during startup must still read as failed.
    if (c.phase === "starting") return c.proc.state === "failed" ? "failed" : "starting";
    return c.proc.state;
  }

  portOf(branchId: string): number | null {
    return this.computes.get(branchId)?.port ?? null;
  }

  runningPorts(): Array<{ branchId: string; port: number }> {
    return [...this.computes.entries()]
      .filter(([, c]) => c.phase === "running" && c.port !== null)
      .map(([branchId, c]) => ({ branchId, port: c.port as number }));
  }

  // Task 8: unlike runningPorts() above, NOT phase-gated to "running" — a caller resolving
  // runningPgVersion (BranchesService.detail()) wants to know the path for the whole entry
  // lifetime (starting/running/stopping), not just once fully up; assertRemovable's in-use check
  // (BuildRegistry) also wants every currently-claimed path regardless of phase.
  runningPgbin(branchId: string): string | null {
    return this.computes.get(branchId)?.pgbinPath ?? null;
  }

  runningPgbins(): string[] {
    return [...this.computes.values()].map((e) => e.pgbinPath).filter((p): p is string => p !== null);
  }

  onLine(branchId: string, cb: (line: string) => void): () => void {
    const c = this.computes.get(branchId);
    if (!c) return () => {};
    c.listeners.push(cb);
    return () => { c.listeners = c.listeners.filter((l) => l !== cb); };
  }

  // Abort fence for the stop()-during-start() race at THIS (ComputeManager) level — the sibling of
  // the ManagedProcess-level guard added in a74b8b1 (process.ts's post-readiness `readState() !==
  // "starting" || this.child !== child` check), which closes the same race one layer down. start()
  // reserves its map slot synchronously (computes.set, proc still null) and then crosses several
  // awaits — allocatePort ×3, mkdir/mkdtemp, writeFile ×2 — BEFORE it constructs entry.proc.
  // Throughout that pre-proc window a concurrent stop()/stopAll() (stopAll runs on daemon shutdown,
  // index.ts, iterating computes directly and thus BYPASSING the per-branch queue lane that
  // otherwise serializes a branch's start/stop) sees entry.proc === null, so it sets
  // entry.phase="stopping", SKIPS proc.stop() (nothing to stop), deletes the map slot, and releases
  // the ports. Without re-checking, the suspended start() would sail on when it resumes: spawn
  // compute_ctl, wait ready, flip entry.phase="running", and return success for an entry no longer
  // in the map — a live compute invisible to statusOf()/runningPorts(), leaked until container
  // teardown, on a port stop() may already have re-handed. Called after every awaited setup step
  // that records a releasable resource on `entry`, and once more before the "running" commit, this
  // re-asserts the invariant the synchronous reservation established: "this slot is still ours, and
  // still starting." If a stop() intervened, entry.phase is now "stopping" (or the slot holds a
  // different entry / no entry after a delete-then-fresh-start), so we throw INTO start()'s existing
  // catch — whose compensation is already idempotent and exactly right for a partially-torn-down
  // entry (map delete no-ops on !== entry, port releases are Set.delete, dir removal is force:true,
  // proc.stop() is a no-op when proc is null or already stopped) — instead of launching or reporting
  // success. Both identity (=== entry) AND phase are checked, mirroring a74b8b1's child-identity +
  // state pair: phase is the primary abort signal, identity backstops a delete-then-fresh-start that
  // reuses the same branch id while this start() was suspended.
  private assertStillStarting(branch: BranchRow, entry: RunningCompute): void {
    if (this.computes.get(branch.id) !== entry || entry.phase !== "starting") {
      throw new Error(`compute start for branch ${branch.name} aborted: stop() intervened during startup`);
    }
  }

  // Owner-safe reserved-port release: delete the port from reservedPorts AND null it on the entry in
  // the same synchronous step. Both start()'s failure `catch` and stop()'s `finally` release the
  // SAME entry's ports, and — only via a lane-bypassing stopAll() racing a same-branch in-flight
  // start (the very interleaving assertStillStarting exists for) — both can run compensation on that
  // one shared entry. If each merely `reservedPorts.delete(entry.port)`, whichever runs SECOND
  // re-deletes a port the first already freed; and if another branch's start (still admissible until
  // stopAll snapshotted its keys) reclaimed that exact port in the gap, the stale re-delete silently
  // evicts the NEW owner's reservation, so a later allocatePort hands the same port out twice. The
  // entry field is the coordination token: whoever releases first nulls it, the other sees null and
  // skips. (A plain Set.delete of an already-absent port is harmless on its own — the hazard is
  // strictly the reclaim-in-between window this null closes.)
  private releasePort(entry: RunningCompute, which: "port" | "metricsPort" | "internalHttpPort"): void {
    const p = entry[which];
    if (p !== null) {
      this.reservedPorts.delete(p);
      entry[which] = null;
    }
  }

  // oracle: neon compute_tools/src/bin/compute_ctl.rs (compute_ctl's launch entrypoint) +
  // compute_tools/src/compute.rs (ComputeNode start/reconfigure lifecycle).
  //
  // Review fix (Fix 1): `onLine` is accepted here (not wired in by a caller after start()
  // resolves) and pushed onto entry.listeners at RESERVATION time — before any `await` — so a
  // caller's launch/failure output is never missed. Previously EndpointsService subscribed via
  // computes.onLine(branchId, cb) only after computes.start() had already resolved successfully;
  // every line printed during the launch itself (including the lines explaining WHY a launch
  // failed — compute_ctl's stdout/stderr right up to the point it exits, surfaced in
  // ManagedProcess's "exited before ready" error message) reached nobody but the bounded
  // in-process ring inside ManagedProcess, never LogsService's `branch:<id>:compute` channel or
  // any SSE client tailing it. Registering the listener in the SAME synchronous tick that reserves
  // the map slot means it's live for the entire lifetime of this compute entry — launch, running,
  // and (via ComputeManager's own listener fanout closure below) right up to the process exiting.
  async start(a: { branch: BranchRow; pgVersion: PgVersion; pgbinPath: string; onLine?: (line: string) => void }): Promise<{ port: number }> {
    const existing = this.computes.get(a.branch.id);
    if (existing) {
      throw new Error(`endpoint for branch ${a.branch.name} already ${this.statusOf(a.branch.id)}`);
    }
    // Reserve the map slot synchronously (before the first await) so a concurrent start()
    // for the same branch sees this entry immediately instead of racing past the check above.
    // pgbinPath is set in this SAME tick (not assigned later) so a concurrent runningPgbin() call
    // can never observe a reserved-but-pgbinPath-less entry.
    // LOAD-BEARING beyond start-dedup: this synchronous set is also what keeps the endpoint-vs-
    // build-lane rm race closed — a build a compute is starting on is "in use" (runningPgbins →
    // provisioner.assertRemovable) before any yield lets remove() rm its --pgbin dir. Do not move
    // the reservation after an await. Pinned by "publishes pgbinPath into runningPgbins() SYNCHRONOUSLY".
    const entry: RunningCompute = {
      proc: null, port: null, metricsPort: null, internalHttpPort: null, dir: null, listeners: [], phase: "starting",
      pgbinPath: a.pgbinPath,
    };
    if (a.onLine) entry.listeners.push(a.onLine);
    this.computes.set(a.branch.id, entry);
    this.notifyStatus(a.branch.id); // reservation: statusOf(branchId) just flipped "stopped" -> "starting"

    let dirCreated: string | null = null;
    try {
      // allocatePort claims each returned port into reservedPorts itself, synchronously before
      // its bind probe (reserve-then-probe — see ports.ts), so parallel starts on other branches
      // can never be handed the same candidate. Recording the port on `entry` in the same tick is
      // what start()'s catch and stop() use to release the claim.
      const port = await allocatePort(this.cfg.portRange, a.branch.stickyPort, this.reservedPorts, this.probe);
      entry.port = port;
      // Abort fence (recorded-resource → then check): if a concurrent stop()/stopAll() claimed this
      // entry while we were suspended in allocatePort, bail into the catch (which now has entry.port
      // to release). Placed AFTER the assignment so the port we just claimed is never orphaned.
      this.assertStillStarting(a.branch, entry);

      const computesDir = engineDirs(this.cfg).computesDir;
      await mkdir(computesDir, { recursive: true });
      const dir = await mkdtemp(join(computesDir, `compute_${a.branch.timelineId}_`));
      dirCreated = dir;
      entry.dir = dir;
      // Abort fence: bail before writing config files INTO a dir a concurrent stop() may already be
      // removing (dirCreated is recorded, so the catch reclaims it either way).
      this.assertStillStarting(a.branch, entry);
      const hbaPath = join(dir, "pg_hba.conf");
      await writeFile(hbaPath, PG_HBA);
      const configPath = join(dir, "config.json");
      await writeFile(configPath, computeConfigJson({
        tenantIdHex: a.branch.projectId,
        timelineIdHex: a.branch.timelineId,
        port, hbaPath,
        password: a.branch.password,
      }));
      const metricsPort = await allocatePort({ min: 40000, max: 40999 }, undefined, this.reservedPorts, this.probe);
      entry.metricsPort = metricsPort;
      this.assertStillStarting(a.branch, entry); // abort fence: metrics port claimed → then check
      // Without an explicit --internal-http-port, compute_ctl binds its internal HTTP server
      // (remote-extension downloads for the neon extension, local_proxy config) to the default
      // 3081 on every compute: the first compute wins the bind and later concurrent computes
      // collide — nonfatal, but that server is silently missing/misrouted for every compute
      // after the first (verified via /proc/net/tcp in a live devdb:dev container).
      const internalHttpPort = await allocatePort({ min: 40000, max: 40999 }, undefined, this.reservedPorts, this.probe);
      entry.internalHttpPort = internalHttpPort;
      // Abort fence: the last gate before we SPAWN. A stop() that intervened during any setup await
      // above already deleted the slot; throwing here avoids launching a compute_ctl that the
      // already-finished stop() (having seen proc===null) will never signal. Defense-in-depth, not
      // solely load-bearing: the post-waitReady fence + catch would still prevent the leak if this
      // were removed — but only after a pointless spawn+kill of a doomed compute. This closes the
      // common pre-proc window cleanly instead.
      this.assertStillStarting(a.branch, entry);

      // oracle args: neon compute_tools/src/bin/compute_ctl.rs Cli struct (--pgdata/--pgbin/
      // --connstr/--compute-id/--external-http-port/--internal-http-port). Readiness: neon polls
      // postmaster.pid directly (compute_tools/src/pg_helpers.rs → wait_for_postgres); DevDB's
      // "listening on IPv4 address" log-line needle (50s timeout) is its own simpler readiness
      // signal for ManagedProcess's generic stdout-watcher.
      entry.proc = new ManagedProcess({
        name: `compute-${a.branch.slug}`,
        bin: join(this.cfg.neonBinDir, "compute_ctl"),
        args: [
          "--pgdata", join(dir, "pg_data"),
          "--pgbin", a.pgbinPath,
          "--compute-id", `compute-${a.branch.timelineId}`,
          "--connstr", `postgresql://cloud_admin@localhost:${port}/postgres`,
          "--config", configPath,
          "--external-http-port", String(metricsPort),
          "--internal-http-port", String(internalHttpPort),
        ],
        env: {},
        readyNeedle: "listening on IPv4 address",
        readyTimeoutMs: 50_000,
        // Own process group: compute_ctl orphans its postgres child on SIGTERM instead of
        // waiting for it (R3 — handover §4.4/§8.6, confirmed live) — group-kill on stop() is the
        // structural fix; reapOrphanedPostgres below stays as a Linux-only backstop for whatever
        // it doesn't structurally prevent (e.g. daemon crash before stop() ever runs).
        detached: true,
        onLine: (line) => {
          // Fan out over a snapshot so one listener throwing doesn't stop the rest, and so
          // unsubscribes during the callback don't mutate the array we're iterating.
          for (const cb of [...entry.listeners]) {
            try {
              cb(line);
            } catch {
              // listener errors must never break the child lifecycle; swallowed by contract.
            }
          }
        },
        // Task 3 (phase 3): the ONLY seam that reports a crash-after-running — no ComputeManager
        // method call happens when compute_ctl dies on its own after start() has already returned.
        // Without this, that transition (statusOf flipping "running" -> "failed") would never
        // reach /api/events at all.
        onStateChange: () => this.notifyStatus(a.branch.id),
      });
      await entry.proc.start();
      // Structural readiness gate (handover §4.3): the needle fires ~80-140ms before apply_spec
      // commits the branch's SCRAM verifier; block until compute_ctl_up{status="running"}.
      await this.waitReady(metricsPort);
      // Abort fence — CRITICAL: the pre-commit gate. entry.proc.start()/waitReady are the WIDEST
      // awaits here (readiness takes seconds), so a stop()/stopAll() most plausibly lands during
      // them. If waitReady RESOLVED "running" (its last poll caught the compute up just before
      // stop()'s SIGTERM), flipping "running" and returning success here would report a live endpoint
      // for a slot stop() has already deleted and a proc it has already ordered dead. Throw into the
      // catch instead (which re-runs proc.stop() idempotently). The a74b8b1 guard covers the sibling
      // window inside entry.proc.start() itself; this covers ComputeManager's own waitReady gate.
      this.assertStillStarting(a.branch, entry);
      entry.phase = "running";
      this.notifyStatus(a.branch.id); // phase flip: statusOf(branchId) just became "running"
      return { port };
    } catch (e) {
      // Failure cleanup follows stop()'s settlement order. Map entry first and unconditionally:
      // a stale entry here makes every later start() for this branch throw "already ..." until
      // the daemon restarts. Task 5: waitReady() throwing (readiness timeout, or status="failed")
      // fires strictly AFTER entry.proc.start() has already resolved successfully — unlike the
      // OLD single readiness gate inside ManagedProcess.start() (which SIGKILLs its own child on
      // ITS OWN timeout, see process.ts), a live compute_ctl here would otherwise never be told to
      // stop, orphaning it exactly like a caller-forgotten stop() would. Explicitly stop the proc
      // BEFORE the dir/reap cleanup below, so removeComputeDir's reapOrphanedPostgres (which only
      // scans for the POSTGRES child, not compute_ctl itself) races a compute_ctl already on its
      // way down rather than one still fully alive and holding the pgdata directory open.
      // entry.proc is only unset here if the throw happened BEFORE it was constructed (port/dir
      // setup above); once constructed, proc.stop() is a safe no-op if compute_ctl already exited
      // on its own (e.g. ManagedProcess.start()'s OWN readiness-needle timeout already SIGKILLed
      // it — see process.ts's catch — so this call just observes an already-null child and returns).
      // Fix 3 (review): proc.stop() is idempotent today, but must never be trusted to stay that
      // way — if it ever rejects, a bare `await` here would replace the original readiness/launch
      // error `e` (masking WHY start() failed) AND skip every line of cleanup below it (stale map
      // entry, leaked dir, leaked ports — the exact failures this whole catch exists to prevent).
      // Swallow (loudly) so `e` always survives to the throw at the bottom and cleanup always runs.
      if (entry.proc) {
        try {
          await entry.proc.stop();
        } catch (stopErr) {
          this.logger.error(`start() cleanup: compute_ctl stop failed for branch ${a.branch.id}`, stopErr);
        }
      }
      // Teardown ownership. When a lane-bypassing stopAll() has taken this entry — deleted it, or set
      // phase="stopping" and is STILL awaiting its own proc.stop() — AND we had already constructed
      // proc, defer the map/dir/port teardown to that stop() instead of doing it here. Two reasons:
      // (a) with proc built, a live compute_ctl still holds the ports and the pgdata dir, and stop()
      // releases them only in its finally AFTER its proc.stop() confirms the process dead — whereas
      // OUR proc.stop() above just returned immediately (the first stop() nulled this.child
      // synchronously, process.ts:220), so releasing here would free a port / rm a dir the still-dying
      // process holds (premature release → a reclaim could collide with it); (b) it avoids a redundant
      // double-teardown. Deferral is only SAFE when proc was built: then every resource on entry was
      // allocated before proc construction — hence before any concurrent stop() could observe
      // proc!=null and take over — so stop() knows, and will release, all of them. In the pre-proc
      // window (proc===null) there is no live holder AND stop() may not know about resources we
      // allocated after it ran, so WE must release them — immediately, which is safe precisely because
      // nothing is bound (releasePort's null-coordination keeps that release exactly-once vs. stop()).
      const stopOwnsTeardown = entry.proc !== null
        && (this.computes.get(a.branch.id) !== entry || entry.phase === "stopping");
      if (!stopOwnsTeardown) {
        if (this.computes.get(a.branch.id) === entry) this.computes.delete(a.branch.id);
        this.notifyStatus(a.branch.id); // terminal: statusOf(branchId) is back to "stopped" post-cleanup
        if (dirCreated) await this.removeComputeDir(dirCreated, "start() failure cleanup");
        this.releasePort(entry, "port");
        this.releasePort(entry, "metricsPort");
        this.releasePort(entry, "internalHttpPort");
      }
      throw e;
    }
  }

  // CONFIRMED live (Task 15, process-tree evidence — see task-15-report.md): `compute_ctl`
  // does NOT wait for its own child `postgres` to exit before it exits on SIGTERM — it orphans
  // postgres (reparented to PID 1) and returns almost instantly. ManagedProcess.stop() correctly
  // waits for compute_ctl's own "exit" event (that contract is sound and unit-tested — see
  // process.test.ts "stop escalates to SIGKILL"), but that leaves the ACTUAL filesystem writer
  // still alive and still touching pg_data when the code below used to proceed straight to
  // rm(entry.dir, ...) — reproduced directly against the real binaries with /proc watched at
  // 200ms resolution: compute_ctl(pid) dies within ~350ms of SIGTERM, postgres(child pid) stays
  // alive indefinitely afterward (observed 15s+ with zero sign of self-terminating), causing an
  // intermittent ENOTEMPTY on the recursive rm() below racing against postgres's still-live
  // writes — and even on the runs where rm() "succeeded", it was silently deleting files out from
  // under a running postgres process, an orphan leak regardless of whether ENOTEMPTY happened to
  // fire that time. Root-caused via a real compute_ctl launch, not guessed. Not something a
  // caller of stop() can retry around: this method deletes the map entry in its `finally` before
  // rm() runs, so a caller-side retry finds `entry` gone and silently no-ops without ever
  // attempting cleanup again — the fix has to live here.
  // Review fix: the original version `return`ed from inside the first matching PID's poll loop
  // on exit — which exits the WHOLE function, not just that PID's handling. Given `mkdtemp`'s
  // uniqueness guarantee, a second match is not expected in practice, but "not expected" is not
  // "impossible" (a future change to the match string, or two computes sharing a stale dir on a
  // bug elsewhere, would silently under-reap here with the old early-return) — so every matching
  // PID is now collected up front and reaped to completion, and a second-or-later match is a loud
  // invariant violation (logged, not silently tolerated) rather than a quiet no-op.
  private async reapOrphanedPostgres(dir: string): Promise<void> {
    const pgDataDir = join(dir, "pg_data");
    let candidatePids: string[];
    try {
      candidatePids = (await readdir("/proc")).filter((p) => /^\d+$/.test(p));
    } catch {
      return; // /proc unavailable (non-Linux dev run) — nothing we can do; rm() below still tries.
    }
    const matches: string[] = [];
    for (const pid of candidatePids) {
      let cmdline: string;
      try {
        cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
      } catch {
        continue; // process exited between readdir and readFile, or we lack permission — skip it.
      }
      if (cmdline.includes(pgDataDir)) matches.push(pid);
    }
    if (matches.length > 1) {
      // mkdtemp-generated compute dirs are expected to be unique — more than one process
      // referencing the SAME pg_data path is an invariant we don't understand yet, not a routine
      // occurrence. Still reap all of them (better an over-eager kill than a leaked writer), but
      // this must be loud: silently reaping N>1 would hide whatever produced the collision.
      this.logger.error(
        `reapOrphanedPostgres: invariant violation — ${matches.length} processes reference ` +
        `${pgDataDir} (expected at most 1, mkdtemp paths should be unique): pids ${matches.join(", ")}`,
      );
    }
    await Promise.all(matches.map((pid) => this.reapOnePid(pid)));
  }

  // Reaps a single orphaned postgres PID to completion: SIGTERM, bounded poll for exit, SIGKILL
  // escalation if still alive, then a short bounded poll for the SIGKILL to actually land before
  // returning — a caller proceeding straight to rm() immediately after SIGKILL is issued (but
  // before the kernel has reaped the process) can still race the same ENOTEMPTY this whole
  // mechanism exists to prevent, just in a narrower window.
  private async reapOnePid(pid: string): Promise<void> {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      return; // already gone
    }
    // Bounded poll for the orphan to actually exit — kill(pid, 0) throws ESRCH once it has.
    if (await this.pollForExit(pid, 50, 100)) return; // exited within 5s of SIGTERM
    // Still alive after 5s of SIGTERM — escalate, matching ManagedProcess.stop()'s own
    // SIGTERM-then-SIGKILL discipline for the immediate child.
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      return; // already gone
    }
    // Give SIGKILL a brief window to actually land before returning to the caller (which
    // immediately attempts rm() on the directory this process still has open).
    if (!(await this.pollForExit(pid, 10, 100))) {
      this.logger.error(`reapOrphanedPostgres: pid ${pid} still alive ~1s after SIGKILL — proceeding anyway`);
    }
  }

  // Polls kill(pid, 0) up to `attempts` times, `delayMs` apart. Returns true as soon as the
  // process is observed gone (ESRCH), false if it's still alive after the full budget.
  private async pollForExit(pid: string, attempts: number, delayMs: number): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      try {
        process.kill(Number(pid), 0);
      } catch {
        return true; // exited
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  }

  // Failure-tolerant compute-dir removal shared by stop() and start()'s failure cleanup: reap
  // any orphaned postgres still writing into `dir`, rm it, and on ENOTEMPTY retry reap+rm
  // exactly once. An ENOTEMPTY on the first rm means some process was still writing to the dir
  // despite the reap pass — most likely a race where the orphan hadn't yet released its file
  // handles at the moment rm() ran, or (rarer) a straggler that appeared after
  // reapOrphanedPostgres's /proc scan completed. One retry is cheap insurance against exactly
  // that race. Any OTHER error (not ENOTEMPTY) is unexpected but handled the same way — logged,
  // not retried, not rethrown.
  //
  // This method must NEVER throw: both call sites are cleanup paths where a throw does damage
  // well beyond a leaked dir. In stop() it runs inside the outer `finally`, and a throw would
  // skip the map/port release after it, which must settle unconditionally regardless of whether
  // directory cleanup succeeded. In start()'s catch, a throw would REPLACE the original launch
  // error the caller is about to rethrow — masking WHY the launch failed — and skip the port
  // release after it. The dir is accepted as leaked instead: loud on failure, never swallowed
  // silently, never blocks the caller (same compensation discipline as the catches elsewhere in
  // this codebase, e.g. timetravel.ts/branches.ts).
  private async removeComputeDir(dir: string, ctx: string): Promise<void> {
    await this.reapOrphanedPostgres(dir);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOTEMPTY") {
        this.logger.error(`${ctx}: rm() failed unexpectedly for ${dir} — giving up (not retried)`, e);
      } else {
        this.logger.error(`${ctx}: rm() hit ENOTEMPTY for ${dir} after reaping — retrying reap+rm once`, e);
        await this.reapOrphanedPostgres(dir);
        try {
          await rm(dir, { recursive: true, force: true });
        } catch (e2) {
          this.logger.error(`${ctx}: retry of reap+rm also failed for ${dir} — giving up`, e2);
        }
      }
    }
  }

  async stop(branchId: string): Promise<void> {
    const entry = this.computes.get(branchId);
    if (!entry) return;
    entry.phase = "stopping";
    this.notifyStatus(branchId); // phase flip: statusOf(branchId) just became "stopping"
    try {
      if (entry.proc) await entry.proc.stop(30_000);
    } finally {
      if (this.computes.get(branchId) === entry) this.computes.delete(branchId);
      if (entry.dir) await this.removeComputeDir(entry.dir, "stop()");
      // Owner-safe (delete + null via releasePort): a same-branch start() suspended mid-setup — only
      // reachable when a lane-bypassing stopAll() runs this stop() alongside it — will hit its own
      // releasePort next; nulling here means whichever runs second skips rather than re-deleting (and
      // possibly evicting a fresh start that reclaimed the port in between).
      this.releasePort(entry, "port");
      this.releasePort(entry, "metricsPort");
      this.releasePort(entry, "internalHttpPort");
      this.notifyStatus(branchId); // terminal: entry removed, statusOf(branchId) is back to "stopped"
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.computes.keys()].map((id) => this.stop(id)));
  }
}
