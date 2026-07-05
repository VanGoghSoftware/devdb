import { mkdir, open, rm } from "node:fs/promises";
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
import { EventsService } from "./services/events.js";
import { createLogger } from "./logging/logger.js";
import { BranchQueue } from "./state/queue.js";
import { reconcileEndpointsOnBoot, sweepComputesDir } from "./state/reconcile.js";
import { engineDirs } from "./engine/configs.js";
import { BuildRegistry } from "./compute/builds/registry.js";
import { detectPostgresVersion } from "./compute/builds/version.js";
import { composePgDistrib } from "./compute/builds/pgdistrib.js";
import { Provisioner, du as duDir, statfsFree } from "./compute/builds/provisioner.js";
import { OciClient } from "./compute/builds/oci.js";
import { makeValidationRunner, sweepValidationProjects } from "./compute/builds/validate.js";

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
    // Phase 3 Task 1: constructed here so GET /api/events has a live EventsService to subscribe
    // against from daemon boot. Task 2 wires this same instance into every mutation service below
    // (projects/branches/endpoints/timetravel) so their create/delete/swap/status seams publish
    // to it; Task 3 wires it into EngineRuntime/ComputeManager's async-observer hooks below (for
    // transitions no service write initiates — a crash, or an engine component dying/restarting).
    const events = new EventsService();
    const logger = createLogger(logs);

    // Task 9 (dynamic-pg-builds): the FULL boot order replacing Task 8's minimal seed/adopt/
    // resolve-only prerequisite. BuildRegistry must exist — and pg_distrib must be composed from
    // it — BEFORE EngineRuntime is even constructed: pageserver.toml's `pg_distrib_dir` now points
    // at `cfg.pgDistribDir` (Task 5), which nothing else creates, and EngineRuntime.start() writes
    // + reads that toml as part of launching the pageserver. Constructing EngineRuntime itself is
    // harmless before this point (its constructor only touches storcon_db), but `await
    // engine.start()` is moved down below `recomposeDistrib()` so the ordering is unambiguous in
    // the source, not just "safe by accident."
    const registry = new BuildRegistry({
      state, pgInstallDir: cfg.pgInstallDir, pgBuildsDir: cfg.pgBuildsDir,
      detectVersion: detectPostgresVersion, logger,
    });
    await mkdir(cfg.pgBuildsDir, { recursive: true });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    const sweptTmp = await registry.sweepTmp();
    if (sweptTmp > 0) console.error(`boot: swept ${sweptTmp} interrupted pg_build extraction(s)`);
    // FIX-5 (final review): no pull survives a restart, so any row still in downloading/validating
    // was orphaned by a crash mid-pull — fail it (terminal + deletable) instead of leaving it
    // stuck forever behind assertRemovable's in-flight 409. Must precede resolveActives so an
    // orphan can never be an active-resolution candidate by way of a later status transition.
    const failedInFlight = registry.failInterrupted();
    if (failedInFlight > 0) {
      console.error(`boot: failed ${failedInFlight} pg_build pull(s) interrupted by restart — delete via DELETE /api/pg-builds/{id}`);
    }
    const { degraded } = registry.resolveActives();
    if (degraded.length > 0) {
      console.error(`boot: PG major(s) ${degraded.join(", ")} resolved BELOW their last-run minor — see /api/status pgBuilds (re-pull to clear)`);
    }
    // Boot GC (spec §Pipeline: keep active + one previous per major) — nothing is running yet, so
    // no in-use check is needed here; runtime deletes still go through assertRemovable.
    for (const stale of registry.gcCandidates()) {
      await rm(stale.path, { recursive: true, force: true });
      state.pgBuilds.delete(stale.id);
      console.error(`boot: GC'd pg build ${stale.major}.${stale.minor} (${stale.releaseTag}) — keep-2 policy`);
    }
    // recomposeDistrib is also handed to the Provisioner below (re-run after every activate/
    // remove) — defined once here so boot and runtime share the exact same composition logic.
    const recomposeDistrib = async () => composePgDistrib({
      distribDir: cfg.pgDistribDir, pgInstallDir: cfg.pgInstallDir,
      downloadedOnly: registry.list().filter((r) => r.source === "downloaded" && r.status === "ready" && r.active)
        .map((r) => ({ major: r.major, path: r.path })),
    });
    await recomposeDistrib(); // MUST precede engine.start(): pageserver.toml's pg_distrib_dir points here

    // Task 3 (phase 3): the 4th ctor arg is the async-observer hook for engine components dying/
    // restarting with no service write (e.g. pageserver crashing mid-session) — publishes a
    // coarse `engine.health` invalidation hint for /api/events subscribers to react to.
    engine = new EngineRuntime(cfg, state, logs, () => events.publish({ type: "engine.health" }));
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
    // Task 3 (phase 3): the 4th ctor arg is the async-observer hook for a compute crashing (or
    // failing to start) with no service write in progress — publishes an `endpoint.status` hint,
    // resolving projectId from state so SSE clients scoped to a project still see it. `undefined`
    // for the 3rd (waitReady) arg keeps the real poller default; only this ctor's tail changes.
    computes = new ComputeManager(cfg, logger, undefined, (branchId) => {
      const b = state.branches.byId(branchId);
      events.publish({ type: "endpoint.status", branchId, projectId: b?.projectId });
    });
    const queue = new BranchQueue();

    // Fix 3: `logs` wired into both ProjectsService and BranchesService (both optional deps) so
    // their delete paths can evict a deleted branch's `branch:<id>:compute` channel.
    // Fix 1 (final review wave): `queue` wired into ProjectsService too — delete()'s per-leaf
    // teardown now runs inside queue.run(leaf.id, ...), the SAME lane BranchesService/
    // EndpointsService already serialize start()/stop()/create()/delete() through for a branch id.
    // Task 4: `logger` wired via the shared ProjectsDeps interface (routes compensation-path
    // console.error calls through LogsService's daemon:app channel, in addition to stderr).
    // Task 2 (phase 3): `events` wired into all four mutation services (shared with the same
    // EventsService instance GET /api/events subscribes against) so every create/delete/swap/
    // endpoint-status seam actually announces its invalidation hint in production, not just
    // under test (`events?` is optional on ProjectsDeps precisely so this wiring can be threaded
    // here without touching every existing unit test's construction).
    // Task 8/9: `builds: registry` (the BuildRegistry constructed above) wired into all three —
    // REQUIRED by EndpointsService (resolves --pgbin fresh per start), OPTIONAL-but-present for
    // ProjectsService (major-installed guard) and BranchesService (runningPgVersion enrichment).
    const projects = new ProjectsService({ state, storcon, pageserver, safekeeper, computes, queue, logs, events, logger, builds: registry });
    const branches = new BranchesService({ state, storcon, pageserver, safekeeper, computes, queue, logs, events, logger, builds: registry });
    const endpoints = new EndpointsService({ state, storcon, pageserver, safekeeper, computes, queue, branches, logs, events, logger, builds: registry });
    const timetravel = new TimeTravelService({ state, storcon, pageserver, safekeeper, computes, queue, branches, endpoints, events, logger });
    const sql = new SqlService({ branches, endpoints });

    // Task 9: a boot-time sweep of orphaned validation-gate projects — left behind only when a
    // prior gate run's own cleanup (validate.ts's finally block) failed (e.g. the daemon crashed
    // mid-gate, or the engine was briefly unreachable during that finally). Runs AFTER the
    // services above exist (sweepValidationProjects calls through the real ProjectsService.delete,
    // which needs a live storcon/pageserver/safekeeper/queue) but BEFORE the Provisioner is
    // constructed, so no new pull can race a leftover gate project sharing engine state.
    const sweptValidate = await sweepValidationProjects(projects);
    if (sweptValidate > 0) {
      console.error(`boot: swept ${sweptValidate} orphaned _devdb_validate_* project(s)`);
    }
    // Task 9: the Provisioner composition root — wires the validation gate (makeValidationRunner,
    // itself built from the real projects/endpoints/sql services above), the OCI puller, disk
    // helpers, and recomposeDistrib (defined above, shared with boot's own initial compose call).
    const provisioner = new Provisioner({
      registry, state, logs, events, logger,
      oci: new OciClient({ registryBase: cfg.pgRegistryBase }),
      cfg: { pgBuildsDir: cfg.pgBuildsDir, pgImageTemplate: cfg.pgImageTemplate },
      validate: makeValidationRunner({ projects, endpoints, sql, logger }),
      detectVersion: detectPostgresVersion, du: duDir, statfsFree, recomposeDistrib,
    });

    // Task 9 fix wave: `logger` threaded into Deps so mcp/tools.ts's guard() can log an
    // unexpected/non-DevdbError tool failure's stack somewhere other than a swallowed message —
    // this is the SAME logger instance already wired into every service above (Task 4).
    // Task 10 (dynamic-pg-builds): `registry`/`provisioner` are now REQUIRED on Deps — the
    // pg-builds REST routes (GET/check/pull/activate/DELETE) and /api/status's real pgBuilds
    // block consume them unconditionally. `computes` (the SAME ComputeManager instance already
    // threaded into projects/branches/endpoints above) is new at this task: GET /api/pg-builds's
    // inUse and DELETE's in-use guard both need runningPgbins(), which isn't exposed through any
    // of those services' own public surfaces (see api.ts's Deps doc comment for why).
    const app = buildServer({
      cfg, state, engine, logs, events, logger, registry, provisioner, computes,
      services: { projects, branches, endpoints, timetravel, sql },
    });
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
