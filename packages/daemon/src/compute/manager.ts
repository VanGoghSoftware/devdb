import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
      proc: null, port: null, metricsPort: null, dir: null, listeners: [], phase: "starting",
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
      if (dirCreated) await rm(dirCreated, { recursive: true, force: true });
      if (this.computes.get(a.branch.id) === entry) this.computes.delete(a.branch.id);
      throw e;
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
      if (entry.dir) await rm(entry.dir, { recursive: true, force: true });
      if (entry.port !== null) this.reservedPorts.delete(entry.port);
      if (entry.metricsPort !== null) this.reservedPorts.delete(entry.metricsPort);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.computes.keys()].map((id) => this.stop(id)));
  }
}
