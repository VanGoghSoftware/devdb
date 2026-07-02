import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EndpointStatus, PgVersion } from "@devdb/shared";
import type { DevdbConfig } from "../config.js";
import type { BranchRow } from "../state/repos.js";
import { engineDirs } from "../engine/configs.js";
import { ManagedProcess } from "../engine/process.js";
import { computeConfigJson } from "./spec.js";
import { PG_HBA } from "./pgconf.js";
import { allocatePort } from "./ports.js";

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

  constructor(private cfg: DevdbConfig) {}

  statusOf(branchId: string): EndpointStatus {
    const c = this.computes.get(branchId);
    if (!c) return "stopped";
    if (c.phase === "stopping") return "stopping";
    if (!c.proc) return "starting";
    return c.proc.state as EndpointStatus;
  }

  portOf(branchId: string): number | null {
    return this.computes.get(branchId)?.port ?? null;
  }

  runningPorts(): Array<{ branchId: string; port: number }> {
    return [...this.computes.entries()]
      .filter(([, c]) => c.proc?.state === "running" && c.port !== null)
      .map(([branchId, c]) => ({ branchId, port: c.port as number }));
  }

  onLine(branchId: string, cb: (line: string) => void): () => void {
    const c = this.computes.get(branchId);
    if (!c) return () => {};
    c.listeners.push(cb);
    return () => { c.listeners = c.listeners.filter((l) => l !== cb); };
  }

  // oracle: src/mgmt/compute/mod.rs:121-289 launch()
  async start(a: { branch: BranchRow; pgVersion: PgVersion }): Promise<{ port: number }> {
    const existing = this.computes.get(a.branch.id);
    if (existing) {
      throw new Error(`endpoint for branch ${a.branch.name} already ${this.statusOf(a.branch.id)}`);
    }
    // Reserve the map slot synchronously (before the first await) so a concurrent start()
    // for the same branch sees this entry immediately instead of racing past the check above.
    const entry: RunningCompute = {
      proc: null, port: null, metricsPort: null, internalHttpPort: null, dir: null, listeners: [], phase: "starting",
    };
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
      entry.phase = "running";
      return { port };
    } catch (e) {
      if (entry.port !== null) this.reservedPorts.delete(entry.port);
      if (entry.metricsPort !== null) this.reservedPorts.delete(entry.metricsPort);
      if (entry.internalHttpPort !== null) this.reservedPorts.delete(entry.internalHttpPort);
      if (dirCreated) await rm(dirCreated, { recursive: true, force: true });
      if (this.computes.get(a.branch.id) === entry) this.computes.delete(a.branch.id);
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
  private async reapOrphanedPostgres(dir: string): Promise<void> {
    const pgDataDir = join(dir, "pg_data");
    let pids: string[];
    try {
      pids = (await readdir("/proc")).filter((p) => /^\d+$/.test(p));
    } catch {
      return; // /proc unavailable (non-Linux dev run) — nothing we can do; rm() below still tries.
    }
    for (const pid of pids) {
      let cmdline: string;
      try {
        cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
      } catch {
        continue; // process exited between readdir and readFile, or we lack permission — skip it.
      }
      if (!cmdline.includes(pgDataDir)) continue;
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        continue; // already gone
      }
      // Bounded poll for the orphan to actually exit — kill(pid, 0) throws ESRCH once it has.
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(Number(pid), 0);
        } catch {
          return; // exited
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      // Still alive after 5s of SIGTERM — escalate, matching ManagedProcess.stop()'s own
      // SIGTERM-then-SIGKILL discipline for the immediate child.
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // already gone
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
      if (entry.dir) {
        await this.reapOrphanedPostgres(entry.dir);
        await rm(entry.dir, { recursive: true, force: true });
      }
      if (entry.port !== null) this.reservedPorts.delete(entry.port);
      if (entry.metricsPort !== null) this.reservedPorts.delete(entry.metricsPort);
      if (entry.internalHttpPort !== null) this.reservedPorts.delete(entry.internalHttpPort);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.computes.keys()].map((id) => this.stop(id)));
  }
}
