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
import { SqlService } from "./services/sql.js";
import { LogsService } from "./services/logs.js";
import { BranchQueue } from "./state/queue.js";
import { reconcileEndpointsOnBoot, sweepComputesDir } from "./state/reconcile.js";
import { engineDirs } from "./engine/configs.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true });

  // oracle: src/daemon/lease/mod.rs — exclusive-create lockfile
  const lockPath = join(cfg.dataDir, ".lock");
  try {
    const fh = await open(lockPath, "wx");
    await fh.close();
  } catch {
    // Fix 3 (review, final wave): name the exact recovery command rather than leaving "remove the
    // file if you are sure" as an exercise for the reader — an unclean shutdown (host reboot,
    // `docker kill`, OOM) skips the SIGTERM handler's `rm(lockPath)` above, leaving this stale
    // lockfile as the only symptom. The command targets the SAME named volume this data dir is
    // mounted from (docker/compose.yaml's `devdb-data:/data`), via a scratch `run --rm` container
    // so no long-lived devdb process needs to be up to clear it.
    console.error(
      `lockfile ${lockPath} exists — another devdb owns this data dir, or it crashed without cleaning up.\n` +
      `Remove it with: docker compose -f docker/compose.yaml run --rm devdb rm /data/.lock — only if no other devdb container is using this volume.`,
    );
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

    // Boot reconciliation (T16; extracted to state/reconcile.ts under Fix 4 for direct unit
    // coverage — see that module's doc comment for the full rationale).
    reconcileEndpointsOnBoot(state);

    // Fix 4 (review, final wave): sweep any compute directories left behind by a compute that was
    // mid-launch/mid-teardown when the container died uncleanly. Runs immediately after
    // reconcileEndpointsOnBoot() and before ComputeManager is even constructed below — nothing can
    // legitimately be running in-container yet, so it's safe to unconditionally rm -rf every entry
    // under computesDir without needing to cross-reference against any in-memory state.
    const sweptComputeDirs = await sweepComputesDir(engineDirs(cfg).computesDir);
    if (sweptComputeDirs > 0) {
      console.error(`boot: swept ${sweptComputeDirs} crash-orphaned compute director${sweptComputeDirs === 1 ? "y" : "ies"} from a previous unclean shutdown`);
    }

    const storcon = new StorconClient();
    const pageserver = new PageserverClient();
    const safekeeper = new SafekeeperClient();
    computes = new ComputeManager(cfg);
    const queue = new BranchQueue();
    // Fix 3: `logs` wired into both ProjectsService and BranchesService (both optional deps) so
    // their delete paths can evict a deleted branch's `branch:<id>:compute` channel.
    // Fix 1 (final review wave): `queue` wired into ProjectsService too — delete()'s per-leaf
    // teardown now runs inside queue.run(leaf.id, ...), the SAME lane BranchesService/
    // EndpointsService already serialize start()/stop()/create()/delete() through for a branch id.
    const projects = new ProjectsService({ state, storcon, pageserver, safekeeper, computes, queue, logs });
    const branches = new BranchesService({ state, storcon, pageserver, safekeeper, computes, queue, logs });
    const endpoints = new EndpointsService({ state, storcon, pageserver, safekeeper, computes, queue, branches, logs });
    const timetravel = new TimeTravelService({ state, storcon, pageserver, safekeeper, computes, queue, branches, endpoints });
    const sql = new SqlService({ branches, endpoints });

    const app = buildServer({ cfg, state, engine, logs, services: { projects, branches, endpoints, timetravel, sql } });
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
