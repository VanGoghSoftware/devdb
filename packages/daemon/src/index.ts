import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openState } from "./state/db.js";
import { EngineRuntime } from "./engine/boot.js";
import { buildServer } from "./http/api.js";
import { StorconClient } from "./engine/storcon-client.js";
import { PageserverClient } from "./engine/pageserver-client.js";
import { SafekeeperClient } from "./engine/safekeeper-client.js";
import { ComputeManager } from "./compute/manager.js";
import { ProjectsService } from "./services/projects.js";
import { BranchesService } from "./services/branches.js";
import { EndpointsService } from "./services/endpoints.js";
import { TimeTravelService } from "./services/timetravel.js";
import { LogsService } from "./services/logs.js";
import { BranchQueue } from "./state/queue.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true });

  // oracle: src/daemon/lease/mod.rs — exclusive-create lockfile
  const lockPath = join(cfg.dataDir, ".lock");
  try {
    const fh = await open(lockPath, "wx");
    await fh.close();
  } catch {
    console.error(`lockfile ${lockPath} exists — another devdb owns this data dir, or it crashed. Remove the file if you are sure no other instance runs.`);
    process.exit(1);
  }

  // Declared outside the try so the outer catch can best-effort tear down whatever came up
  // before the failure (e.g. the engine started but a later boot step threw) — otherwise a
  // post-start failure would leave the engine processes running with no daemon left to manage
  // them (and no lockfile, since we remove it below).
  let engine: EngineRuntime | undefined;
  let computes: ComputeManager | undefined;
  try {
    const state = openState(join(cfg.dataDir, "state.db"));
    const logs = new LogsService();
    engine = new EngineRuntime(cfg, state, logs);
    await engine.start();

    // Boot reconciliation (T16): every branch row left at a non-"stopped" endpoint_status
    // belongs to a compute process that died with the previous container — ComputeManager
    // starts this run with an empty map, so nothing is actually running regardless of what the
    // row says. Reset status/port only; endpoint_error is diagnostic history and is preserved
    // (a branch that failed before the restart should still show why on next inspection).
    for (const p of state.projects.list()) {
      for (const b of state.branches.listByProject(p.id)) {
        if (b.endpointStatus !== "stopped") {
          state.branches.updateEndpoint(b.id, { status: "stopped", port: null, error: b.endpointError });
        }
      }
    }

    const storcon = new StorconClient();
    const pageserver = new PageserverClient();
    const safekeeper = new SafekeeperClient();
    computes = new ComputeManager(cfg);
    const projects = new ProjectsService({ state, storcon, pageserver, safekeeper, computes });
    const queue = new BranchQueue();
    const branches = new BranchesService({ state, storcon, pageserver, safekeeper, computes, queue });
    const endpoints = new EndpointsService({ state, storcon, pageserver, safekeeper, computes, queue, branches, logs });
    const timetravel = new TimeTravelService({ state, storcon, pageserver, safekeeper, computes, queue, branches, endpoints });

    const app = buildServer({ cfg, state, engine, logs, services: { projects, branches, endpoints, timetravel } });
    await app.listen({ host: "0.0.0.0", port: cfg.httpPort });

    // Both are always assigned by this point (we're past the two lines above that set them) —
    // rebind to non-optional consts so the shutdown closure below doesn't need `engine`/`computes`
    // to be `| undefined` (they only carry that wider type for the outer catch's best-effort
    // cleanup of a boot that failed before reaching here).
    const runningEngine = engine;
    const runningComputes = computes;

    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) {
        console.error("second signal — forcing immediate exit");
        process.exit(130);
      }
      stopping = true;

      // Belt-and-suspenders: if any shutdown step hangs, don't leave the process running forever.
      const hardExit = setTimeout(() => {
        console.error("shutdown timed out — forcing exit");
        process.exit(1);
      }, 45_000);
      hardExit.unref();

      console.error(`received ${signal}, shutting down`);
      let ok = true;

      try {
        await app.close();
      } catch (e) {
        ok = false;
        console.error("error closing http server:", e);
      }

      try {
        await runningComputes.stopAll();
      } catch (e) {
        ok = false;
        console.error("error stopping computes:", e);
      }

      try {
        await runningEngine.stop();
      } catch (e) {
        ok = false;
        console.error("error stopping engine:", e);
      }

      try {
        await rm(lockPath, { force: true });
      } catch (e) {
        ok = false;
        console.error("error removing lockfile:", e);
      }

      process.exit(ok ? 0 : 1);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  } catch (e) {
    console.error("boot failed:", e);
    // best-effort: if the engine (or computes) came up before the failure, don't leave them
    // running unmanaged once this process exits and the lockfile is gone.
    await computes?.stopAll().catch(() => {});
    await engine?.stop().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
