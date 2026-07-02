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
  proc: ManagedProcess;
  port: number;
  dir: string;
  listeners: Array<(line: string) => void>;
}

export class ComputeManager {
  private computes = new Map<string, RunningCompute>();

  constructor(private cfg: DevdbConfig) {}

  statusOf(branchId: string): EndpointStatus {
    const c = this.computes.get(branchId);
    if (!c) return "stopped";
    return c.proc.state as EndpointStatus;
  }

  portOf(branchId: string): number | null {
    return this.computes.get(branchId)?.port ?? null;
  }

  runningPorts(): Array<{ branchId: string; port: number }> {
    return [...this.computes.entries()]
      .filter(([, c]) => c.proc.state === "running")
      .map(([branchId, c]) => ({ branchId, port: c.port }));
  }

  onLine(branchId: string, cb: (line: string) => void): () => void {
    const c = this.computes.get(branchId);
    if (!c) return () => {};
    c.listeners.push(cb);
    return () => { c.listeners = c.listeners.filter((l) => l !== cb); };
  }

  // oracle: src/mgmt/compute/mod.rs:121-289 launch()
  async start(a: { branch: BranchRow; pgVersion: PgVersion }): Promise<{ port: number }> {
    if (this.computes.get(a.branch.id)?.proc.state === "running") {
      throw new Error(`endpoint for branch ${a.branch.name} already running`);
    }
    const port = await allocatePort(this.cfg.portRange, a.branch.stickyPort);
    const computesDir = engineDirs(this.cfg).computesDir;
    await mkdir(computesDir, { recursive: true });
    const dir = await mkdtemp(join(computesDir, `compute_${a.branch.timelineId}_`));
    const hbaPath = join(dir, "pg_hba.conf");
    await writeFile(hbaPath, PG_HBA);
    const configPath = join(dir, "config.json");
    await writeFile(configPath, computeConfigJson({
      tenantIdHex: a.branch.projectId,
      timelineIdHex: a.branch.timelineId,
      port, hbaPath,
      password: a.branch.password,
    }));
    const metricsPort = await allocatePort({ min: 40000, max: 40999 });

    const entry: RunningCompute = { port, dir, listeners: [], proc: null as unknown as ManagedProcess };
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
      onLine: (line) => entry.listeners.forEach((cb) => cb(line)),
    });
    this.computes.set(a.branch.id, entry);
    try {
      await entry.proc.start();
    } catch (e) {
      this.computes.delete(a.branch.id);
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    return { port };
  }

  async stop(branchId: string): Promise<void> {
    const c = this.computes.get(branchId);
    if (!c) return;
    await c.proc.stop(30_000);
    this.computes.delete(branchId);
    await rm(c.dir, { recursive: true, force: true });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.computes.keys()].map((id) => this.stop(id)));
  }
}
