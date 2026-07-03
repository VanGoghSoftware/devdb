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
import { allocatePort } from "./ports.js";
import { waitComputeReady } from "./readiness.js";

interface RunningCompute {
  proc: ManagedProcess | null;
  port: number | null;
  metricsPort: number | null;
  internalHttpPort: number | null;
  dir: string | null;
  listeners: Array<(line: string) => void>;
  phase: "starting" | "running" | "stopping";
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
  ) {}

  statusOf(branchId: string): EndpointStatus {
    const c = this.computes.get(branchId);
    if (!c) return "stopped";
    if (c.phase === "stopping") return "stopping";
    if (!c.proc) return "starting";
    // Readiness window: the needle has fired (proc.state "running") but apply_spec/SCRAM has not
    // committed. Do NOT expose "running" (detail() would hand out a connection string into the
    // first-start auth race). A crash during startup must still read as failed.
    if (c.phase === "starting") return c.proc.state === "failed" ? "failed" : "starting";
    return c.proc.state as EndpointStatus;
  }

  portOf(branchId: string): number | null {
    return this.computes.get(branchId)?.port ?? null;
  }

  runningPorts(): Array<{ branchId: string; port: number }> {
    return [...this.computes.entries()]
      .filter(([, c]) => c.phase === "running" && c.port !== null)
      .map(([branchId, c]) => ({ branchId, port: c.port as number }));
  }

  onLine(branchId: string, cb: (line: string) => void): () => void {
    const c = this.computes.get(branchId);
    if (!c) return () => {};
    c.listeners.push(cb);
    return () => { c.listeners = c.listeners.filter((l) => l !== cb); };
  }

  // oracle: src/mgmt/compute/mod.rs:121-289 launch()
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
  async start(a: { branch: BranchRow; pgVersion: PgVersion; onLine?: (line: string) => void }): Promise<{ port: number }> {
    const existing = this.computes.get(a.branch.id);
    if (existing) {
      throw new Error(`endpoint for branch ${a.branch.name} already ${this.statusOf(a.branch.id)}`);
    }
    // Reserve the map slot synchronously (before the first await) so a concurrent start()
    // for the same branch sees this entry immediately instead of racing past the check above.
    const entry: RunningCompute = {
      proc: null, port: null, metricsPort: null, internalHttpPort: null, dir: null, listeners: [], phase: "starting",
    };
    if (a.onLine) entry.listeners.push(a.onLine);
    this.computes.set(a.branch.id, entry);

    let dirCreated: string | null = null;
    try {
      const port = await allocatePort(this.cfg.portRange, a.branch.stickyPort, this.reservedPorts);
      this.reservedPorts.add(port);
      entry.port = port;

      const computesDir = engineDirs(this.cfg).computesDir;
      await mkdir(computesDir, { recursive: true });
      const dir = await mkdtemp(join(computesDir, `compute_${a.branch.timelineId}_`));
      dirCreated = dir;
      entry.dir = dir;
      const hbaPath = join(dir, "pg_hba.conf");
      await writeFile(hbaPath, PG_HBA);
      const configPath = join(dir, "config.json");
      await writeFile(configPath, computeConfigJson({
        tenantIdHex: a.branch.projectId,
        timelineIdHex: a.branch.timelineId,
        port, hbaPath,
        password: a.branch.password,
      }));
      const metricsPort = await allocatePort({ min: 40000, max: 40999 }, undefined, this.reservedPorts);
      this.reservedPorts.add(metricsPort);
      entry.metricsPort = metricsPort;
      // Without an explicit --internal-http-port, compute_ctl binds its internal HTTP server
      // (remote-extension downloads for the neon extension, local_proxy config) to the default
      // 3081 on every compute: the first compute wins the bind and later concurrent computes
      // collide — nonfatal, but that server is silently missing/misrouted for every compute
      // after the first (verified via /proc/net/tcp in a live devdb:dev container).
      const internalHttpPort = await allocatePort({ min: 40000, max: 40999 }, undefined, this.reservedPorts);
      this.reservedPorts.add(internalHttpPort);
      entry.internalHttpPort = internalHttpPort;

      // oracle args: src/mgmt/compute/mod.rs:189-208; readiness: :245-252 ("listening on IPv4 address", 50s)
      entry.proc = new ManagedProcess({
        name: `compute-${a.branch.slug}`,
        bin: join(this.cfg.neonBinDir, "compute_ctl"),
        args: [
          "--pgdata", join(dir, "pg_data"),
          "--pgbin", join(this.cfg.pgInstallDir, `v${a.pgVersion}`, "bin", "postgres"),
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
      });
      await entry.proc.start();
      // Structural readiness gate (handover §4.3): the needle fires ~80-140ms before apply_spec
      // commits the branch's SCRAM verifier; block until compute_ctl_up{status="running"}.
      await this.waitReady(metricsPort);
      entry.phase = "running";
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
      if (this.computes.get(a.branch.id) === entry) this.computes.delete(a.branch.id);
      if (dirCreated) await this.removeComputeDir(dirCreated, "start() failure cleanup");
      if (entry.port !== null) this.reservedPorts.delete(entry.port);
      if (entry.metricsPort !== null) this.reservedPorts.delete(entry.metricsPort);
      if (entry.internalHttpPort !== null) this.reservedPorts.delete(entry.internalHttpPort);
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
    try {
      if (entry.proc) await entry.proc.stop(30_000);
    } finally {
      if (this.computes.get(branchId) === entry) this.computes.delete(branchId);
      if (entry.dir) await this.removeComputeDir(entry.dir, "stop()");
      if (entry.port !== null) this.reservedPorts.delete(entry.port);
      if (entry.metricsPort !== null) this.reservedPorts.delete(entry.metricsPort);
      if (entry.internalHttpPort !== null) this.reservedPorts.delete(entry.internalHttpPort);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.computes.keys()].map((id) => this.stop(id)));
  }
}
