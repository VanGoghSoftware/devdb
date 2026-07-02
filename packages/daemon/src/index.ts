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

  try {
    const state = openState(join(cfg.dataDir, "state.db"));
    const engine = new EngineRuntime(cfg, state);
    await engine.start();

    const storcon = new StorconClient();
    const pageserver = new PageserverClient();
    const safekeeper = new SafekeeperClient();
    const computes = new ComputeManager(cfg);
    const projects = new ProjectsService({ state, storcon, pageserver, safekeeper, computes });
    const queue = new BranchQueue();
    const branches = new BranchesService({ state, storcon, pageserver, safekeeper, computes, queue });

    const app = buildServer({ cfg, state, engine, services: { projects, branches } });
    await app.listen({ host: "0.0.0.0", port: cfg.httpPort });

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
        await computes.stopAll();
      } catch (e) {
        ok = false;
        console.error("error stopping computes:", e);
      }

      try {
        await engine.stop();
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
    await rm(lockPath, { force: true }).catch(() => {});
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
