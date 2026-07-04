import { access, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { BuildRegistry } from "../src/compute/builds/registry.js";
import { Provisioner } from "../src/compute/builds/provisioner.js";
import { makeValidationRunner } from "../src/compute/builds/validate.js";
import { LogsService } from "../src/services/logs.js";
import { EventsService } from "../src/services/events.js";
import { DevdbError } from "../src/services/errors.js";
import type { OciPuller } from "../src/compute/builds/oci.js";
import type { ProjectsService } from "../src/services/projects.js";
import type { EndpointsService } from "../src/services/endpoints.js";
import type { BranchRow, ProjectRow } from "../src/state/repos.js";
import type { DevdbEvent } from "@devdb/shared";
import { cleanupDirs, fakeInstallDir, fakeVolumeBuild, noopLogger, scaffoldBuildDirs, trackedDirs } from "./helpers/build-fixtures.js";

// Fix round 1 (review of Task 10 commit 3bfc859, Fix #2, P3 — mutation lane): rm is the only
// fs call the new remove()-vs-activate() race test needs to defer (Provisioner.remove awaits
// `rm(row.path, ...)` before touching SQLite) — same rationale/pattern as manager.test.ts's own
// rmMock (only rm is mocked; everything else, including this file's own extract/fixup/gate-
// cleanup rm calls in every OTHER test, passes through to the real implementation via the
// beforeEach reset below).
const rmMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: rmMock };
});
const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const dirs = trackedDirs();
beforeEach(() => {
  rmMock.mockReset();
  rmMock.mockImplementation(realFs.rm);
});
afterEach(async () => { await cleanupDirs(dirs); });

const DIGEST_A = "sha256:" + "a".repeat(64);
const DIGEST_B = "sha256:" + "b".repeat(64);
// Content-address components (shortDigest): first 16 hex chars after the sha256: prefix.
const SHORT_A = DIGEST_A.slice(7, 23);
const SHORT_B = DIGEST_B.slice(7, 23);

// A fake OciPuller that writes a scaffold `bin/postgres` into destDir — standing in for a real
// pull/extract. Returns spies so tests can assert call counts precisely (dedup / preflight cases).
function fakeOci(a: { digest?: string } = {}): {
  oci: OciPuller; resolveDigestSpy: ReturnType<typeof vi.fn>; pullPrefixSpy: ReturnType<typeof vi.fn>;
} {
  const digest = a.digest ?? DIGEST_A;
  const resolveDigestSpy = vi.fn(async () => ({ digest }));
  const pullPrefixSpy = vi.fn(async (p: { destDir: string; onProgress?: (line: string) => void }) => {
    await mkdir(join(p.destDir, "bin"), { recursive: true });
    await writeFile(join(p.destDir, "bin", "postgres"), "#!/bin/sh\n");
    p.onProgress?.("layer 1/1: 5.0 MB / 5.0 MB");
  });
  return { oci: { resolveDigest: resolveDigestSpy, pullPrefix: pullPrefixSpy }, resolveDigestSpy, pullPrefixSpy };
}

// A blocking OciPuller for the concurrency test: pullPrefix hangs until `release()` is called.
function blockingOci(digest = DIGEST_A): { oci: OciPuller; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const oci: OciPuller = {
    resolveDigest: async () => ({ digest }),
    pullPrefix: async (p) => {
      await gate;
      await mkdir(join(p.destDir, "bin"), { recursive: true });
      await writeFile(join(p.destDir, "bin", "postgres"), "#!/bin/sh\n");
    },
  };
  return { oci, release };
}

// Wires a real StateDb + real BuildRegistry (over scaffolded temp dirs) + real LogsService/
// EventsService behind a Provisioner, with every other dep a typed fake/default. Every test
// overrides only the dep(s) relevant to what it's proving.
function makeProvisioner(a: {
  install: string; builds: string;
  oci: OciPuller;
  validate?: (v: { major: number; buildPath: string; signal?: AbortSignal }) => Promise<void>;
  detectVersion?: (pgbin: string) => Promise<{ major: number; minor: number }>;
  statfsFree?: (dir: string) => Promise<number>;
  du?: (dir: string) => Promise<number | null>;
  gateTimeoutMs?: number;
}) {
  const state = openState(":memory:");
  const detectVersion = a.detectVersion ?? (async () => ({ major: 17, minor: 5 }));
  const registry = new BuildRegistry({
    state, pgInstallDir: a.install, pgBuildsDir: a.builds, logger: noopLogger, detectVersion,
  });
  const logs = new LogsService();
  const events = new EventsService();
  const recomposeDistrib = vi.fn(async () => {});
  const provisioner = new Provisioner({
    registry, oci: a.oci, state, logs, events,
    cfg: { pgBuildsDir: a.builds, pgImageTemplate: "neondatabase/compute-node-v{major}", gateTimeoutMs: a.gateTimeoutMs },
    validate: a.validate ?? (async () => {}),
    detectVersion,
    du: a.du ?? (async () => 1024 * 1024),
    statfsFree: a.statfsFree ?? (async () => 10 * 2 ** 30),
    recomposeDistrib,
    logger: noopLogger,
  });
  return { state, registry, logs, events, provisioner, recomposeDistrib };
}

describe("Provisioner", () => {
  it("pull happy path: downloading→validating→ready+active; build.json written; events published; log channel has layer lines", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci } = fakeOci();
    const { state, provisioner, events, logs, recomposeDistrib } = makeProvisioner({ install, builds, oci });

    const collected: DevdbEvent[] = [];
    events.subscribe((e) => collected.push(e));

    const { buildId } = await provisioner.pull({ major: 17 });
    expect(buildId).toBeTruthy();

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("ready");
      return r!;
    });

    expect(row.active).toBe(true);
    expect(row.source).toBe("downloaded");
    expect(row.major).toBe(17);
    expect(row.minor).toBe(5);
    expect(row.imageDigest).toBe(DIGEST_A);
    expect(row.sizeBytes).toBe(1024 * 1024);

    const marker = JSON.parse(await readFile(join(row.path, "build.json"), "utf8")) as {
      digest: string; tag: string; major: number; minor: number; extractedAt: string;
    };
    expect(marker).toMatchObject({ digest: DIGEST_A, tag: "latest", major: 17, minor: 5 });
    expect(typeof marker.extractedAt).toBe("string");

    // Every state transition publishes a bare {type:"pg_builds"} event — expect at least
    // downloading→(digest known)→validating→ready+active worth of publishes.
    expect(collected.length).toBeGreaterThan(0);
    for (const e of collected) expect(e.type).toBe("pg_builds");

    // Log channel has the layer-progress line the fake oci emitted via onProgress.
    const tail = logs.recent(`pgbuild:${buildId}`);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.some((l) => l.includes("layer 1/1"))).toBe(true);

    expect(recomposeDistrib).toHaveBeenCalled();
  });

  it("second pull while one runs → DevdbError 409", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci, release } = blockingOci();
    const { provisioner, state } = makeProvisioner({ install, builds, oci });

    const first = provisioner.pull({ major: 17 });
    await expect(provisioner.pull({ major: 16 })).rejects.toThrow(/already in progress/);

    release();
    const { buildId } = await first;
    await vi.waitFor(() => expect(state.pgBuilds.byId(buildId)?.status).toBe("ready"));

    // The mutex must have cleared: a THIRD pull (after the first settled) must be ACCEPTED, not
    // rejected with 409 — proves `finally` actually released the flag rather than latching it
    // forever. (If pull() rejected here, this await would throw and fail the test.)
    const { buildId: thirdId } = await provisioner.pull({ major: 16, tag: "latest" });
    expect(thirdId).toBeTruthy();
    expect(thirdId).not.toBe(buildId);
  });

  it("gate failure: dir deleted, row failed with reason, active pointer unchanged", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    await fakeInstallDir(install, "v17"); // baked v17, will be seeded + active
    const { oci } = fakeOci();
    const { state, registry, provisioner } = makeProvisioner({
      install, builds, oci,
      validate: async () => { throw new Error("compute never became ready"); },
    });
    await registry.seedBaked();
    registry.resolveActives(); // baked-v17 active

    const { buildId } = await provisioner.pull({ major: 17 });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("failed");
      return r!;
    });

    expect(row.error).toMatch(/compute never became ready/);
    await expect(access(row.path)).rejects.toThrow(); // extracted dir was deleted, no corpse
    expect(registry.pgbinFor(17).buildId).toBe("baked-v17"); // active pointer untouched
  });

  it('digest dedup: already-installed digest → row failed with "already installed" and NO oci.pullPrefix call', async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci, pullPrefixSpy } = fakeOci({ digest: DIGEST_A });
    const { state, provisioner } = makeProvisioner({ install, builds, oci });

    // Pre-insert a ready row already at DIGEST_A (simulating "already installed").
    state.pgBuilds.insert({
      id: "pre-existing", major: 17, minor: 5, source: "downloaded", releaseTag: "9000",
      imageDigest: DIGEST_A, path: join(builds, "v17", "9000"), status: "ready",
    });

    const { buildId } = await provisioner.pull({ major: 17, tag: "latest" });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("failed");
      return r!;
    });
    expect(row.error).toMatch(/already installed/);
    expect(pullPrefixSpy).not.toHaveBeenCalled();
  });

  it("detected major mismatch → failed row, no rename into place", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci } = fakeOci();
    const { state, provisioner } = makeProvisioner({
      install, builds, oci,
      detectVersion: async () => ({ major: 16, minor: 3 }), // requested 17, image is actually 16
    });

    const { buildId } = await provisioner.pull({ major: 17 });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("failed");
      return r!;
    });
    expect(row.error).toMatch(/16\.3/);
    expect(row.error).toMatch(/expected major 17/);

    // No finalDir should exist under pgBuildsDir/v17/<tag> (the tmp dir was never renamed there).
    await expect(access(join(builds, "v17", "latest"))).rejects.toThrow();
  });

  it("preflight disk: statfsFree below floor → failed before resolveDigest", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci, resolveDigestSpy } = fakeOci();
    const { state, provisioner } = makeProvisioner({
      install, builds, oci,
      statfsFree: async () => 1 * 2 ** 30, // 1 GB < 1.5 GB floor
    });

    const { buildId } = await provisioner.pull({ major: 17 });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("failed");
      return r!;
    });
    expect(row.error).toMatch(/disk space/);
    expect(resolveDigestSpy).not.toHaveBeenCalled();
  });

  // Not one of the brief's 7 required cases, but the design spec explicitly calls out this path
  // ("Nonexistent-repo majors fail the pull with the registry's 404 surfaced cleanly") and it's
  // the one branch (resolveDigest itself throwing) not otherwise exercised by the 7 — the outer
  // catch in runPipeline is what's supposed to record a failed row for it.
  it("resolveDigest throwing (e.g. registry 404) surfaces as a failed row, not an unhandled rejection", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const oci: OciPuller = {
      resolveDigest: async () => { throw new Error("GET .../manifests/latest failed: 404 not found"); },
      pullPrefix: async () => { throw new Error("must not be called"); },
    };
    const { state, provisioner } = makeProvisioner({ install, builds, oci });

    const { buildId } = await provisioner.pull({ major: 99 });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("failed");
      return r!;
    });
    expect(row.error).toMatch(/404 not found/);

    // Mutex must still clear on this path too — a subsequent pull must be ACCEPTED, not rejected.
    const { buildId: nextId } = await provisioner.pull({ major: 16 });
    expect(nextId).not.toBe(buildId);
  });

  it("mutable-tag re-pull: same tag at a NEW digest installs a NEW build in a digest-named dir; the old digest's row and dir persist", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    // Seed: an earlier `latest` pull, ready + active at digest A, living in its digest-named dir.
    const oldDir = await fakeVolumeBuild(builds, 17, SHORT_A,
      { digest: DIGEST_A, tag: "latest", major: 17, minor: 4, extractedAt: "x" });
    // The registry now serves a NEWER digest for the same `latest` tag (a new minor was published).
    const { oci } = fakeOci({ digest: DIGEST_B });
    const { state, provisioner } = makeProvisioner({ install, builds, oci });
    state.pgBuilds.insert({
      id: "old-latest", major: 17, minor: 4, source: "downloaded", releaseTag: "latest",
      imageDigest: DIGEST_A, path: oldDir, status: "ready",
    });
    state.pgBuilds.setActiveExclusive("old-latest");

    // Same tag, new digest — the old (major, tag) identity model made this collide and throw.
    const { buildId } = await provisioner.pull({ major: 17, tag: "latest" });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("ready");
      return r!;
    });
    expect(row.active).toBe(true);
    expect(row.imageDigest).toBe(DIGEST_B);
    expect(row.releaseTag).toBe("latest"); // tag survives as metadata (what was asked for)
    expect(row.path).toBe(join(builds, "v17", SHORT_B)); // digest-derived dir, no tag collision
    await access(join(row.path, "bin", "postgres"));

    // The old digest's row + dir persist untouched (until GC) — only the active pointer moved.
    expect(state.pgBuilds.byId("old-latest")).toMatchObject({
      status: "ready", active: false, imageDigest: DIGEST_A, path: oldDir,
    });
    await access(join(oldDir, "bin", "postgres"));
  });

  it("pull() inserts the downloading row BEFORE returning — an immediate byId(buildId) poll sees it", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci, release } = blockingOci(); // pipeline held open inside pullPrefix
    const { state, provisioner } = makeProvisioner({ install, builds, oci });

    const { buildId } = await provisioner.pull({ major: 17 });

    // Synchronously after pull() resolves: the row must already exist, in `downloading`.
    const row = state.pgBuilds.byId(buildId);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("downloading");
    expect(row?.releaseTag).toBe("latest");
    expect(row?.source).toBe("downloaded");

    release(); // let the pipeline finish so no async work outlives the test
    await vi.waitFor(() => expect(state.pgBuilds.byId(buildId)?.status).toBe("ready"));
  });

  it("malformed tag → 400 before any row, path, or network work; mutex not latched", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci, resolveDigestSpy, pullPrefixSpy } = fakeOci();
    const { state, provisioner } = makeProvisioner({ install, builds, oci });

    for (const tag of ["../x", "a/b"]) {
      try {
        await provisioner.pull({ major: 17, tag });
        expect.unreachable(`pull must reject tag ${tag}`);
      } catch (e) {
        expect(e).toBeInstanceOf(DevdbError);
        if (e instanceof DevdbError) {
          expect(e.statusCode).toBe(400);
          expect(e.message).toBe(`invalid tag: ${tag}`);
        }
      }
    }
    expect(resolveDigestSpy).not.toHaveBeenCalled();
    expect(pullPrefixSpy).not.toHaveBeenCalled();
    expect(state.pgBuilds.list()).toEqual([]); // no row was ever inserted

    // The rejection must not have latched the single-flight mutex — a valid pull still runs.
    const { buildId } = await provisioner.pull({ major: 17 });
    await vi.waitFor(() => expect(state.pgBuilds.byId(buildId)?.status).toBe("ready"));
  });

  it("non-409 activate() failure propagates: row AND job end failed, not ready-but-inactive", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci } = fakeOci();
    const { state, registry, provisioner } = makeProvisioner({ install, builds, oci });
    vi.spyOn(registry, "activate").mockImplementation(() => {
      throw new Error("sqlite: disk I/O error"); // a genuine malfunction, NOT a downgrade 409
    });

    const { buildId } = await provisioner.pull({ major: 17 });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("failed");
      return r!;
    });
    expect(row.error).toMatch(/disk I\/O error/);
    const job = state.raw.prepare("SELECT status FROM jobs WHERE kind = 'pg_build_pull'").get() as { status: string };
    expect(job.status).toBe("failed");
  });

  it("non-409 activate() failure cleans up finalDir so a same-digest retry isn't poisoned by ENOTEMPTY", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci } = fakeOci();
    const { state, registry, provisioner } = makeProvisioner({ install, builds, oci });
    const activateSpy = vi.spyOn(registry, "activate").mockImplementation(() => {
      throw new Error("sqlite: disk I/O error"); // a genuine malfunction, NOT a downgrade 409
    });

    const { buildId } = await provisioner.pull({ major: 17 });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("failed");
      return r!;
    });
    expect(row.error).toMatch(/disk I\/O error/);
    // The extracted dir must be gone — left behind, it would poison a same-digest retry: the
    // retry's rename(tmpDir, finalDir) would fail ENOTEMPTY against the leftover.
    await expect(access(row.path)).rejects.toThrow();

    // Un-break activate() and retry at the SAME digest: the retry must reach ready, proving the
    // cleanup actually unpoisoned the content-addressed dir rather than just deleting evidence.
    activateSpy.mockRestore();
    const { buildId: retryId } = await provisioner.pull({ major: 17 });
    await vi.waitFor(() => expect(state.pgBuilds.byId(retryId)?.status).toBe("ready"));
    expect(state.pgBuilds.byId(retryId)?.active).toBe(true);
  });

  it("activate() 409 (deliberate downgrade re-pull) stays tolerated: ready-but-inactive, pipeline completes", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci } = fakeOci();
    const { state, registry, provisioner, recomposeDistrib } = makeProvisioner({ install, builds, oci });
    vi.spyOn(registry, "activate").mockImplementation(() => {
      throw new DevdbError(409, "activating 17.5 would downgrade below the last-run 17.9");
    });

    const { buildId } = await provisioner.pull({ major: 17 });

    await vi.waitFor(() => expect(recomposeDistrib).toHaveBeenCalled()); // ran PAST the tolerated 409
    expect(state.pgBuilds.byId(buildId)).toMatchObject({ status: "ready", active: false, error: null });
  });

  // Fix round 1 (compensation gaps, review of Task 8 commit 43ce4b7): a failure AFTER activate()
  // has already succeeded (here, recomposeDistrib throwing) must not strand the major with NO
  // active build. Before this fix, the outer catch only marked the new row failed and rm'd its
  // dir — the previously-active baked build stayed cleared (activate() unconditionally clears the
  // major's old active before setting the new one), so pgbinFor(major) would 409 until the next
  // boot's resolveActives(). The fix calls registry.resolveActives() in this failure path, which
  // re-picks the newest ready build per major — excluding the now-failed new row — so the older
  // ready (baked) build becomes active again.
  it("post-activate failure (recomposeDistrib throws) restores the previously-active baked build — major not stranded", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    await fakeInstallDir(install, "v17"); // baked v17, will be seeded + active
    const { oci } = fakeOci();
    const { state, registry, provisioner, recomposeDistrib } = makeProvisioner({ install, builds, oci });
    await registry.seedBaked();
    registry.resolveActives(); // baked-v17 active
    expect(registry.pgbinFor(17).buildId).toBe("baked-v17");

    // activate() succeeds (no downgrade — baked has no minor probe conflict here); the failure
    // happens strictly AFTER activation, in recomposeDistrib.
    recomposeDistrib.mockRejectedValueOnce(new Error("recomposeDistrib: symlink farm rebuild failed"));

    const { buildId } = await provisioner.pull({ major: 17 });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("failed");
      return r!;
    });
    expect(row.error).toMatch(/symlink farm rebuild failed/);
    expect(row.active).toBe(false);

    // The major must not be stranded: the previously-active baked build is active again, and
    // pgbinFor resolves it — not a 409.
    const bakedRow = state.pgBuilds.byId("baked-v17")!;
    expect(bakedRow.active).toBe(true);
    expect(registry.pgbinFor(17).buildId).toBe("baked-v17");
  });

  // Fix 3 (task-9 gate integration): when the gate's Promise.race timeout wins, the losing
  // validate() used to keep running with nobody listening — its `finally` cleanup (project
  // delete) unreachable until the hung step's OWN timeout (readyTimeout ~50s) let it settle, so
  // the `_devdb_validate_` project/branch/compute stayed alive long past the pull's failure (the
  // boot sweep being only an eventual backstop). The Provisioner now aborts an AbortSignal when
  // the timeout fires; the REAL runner (makeValidationRunner, wired here over service fakes with
  // a compute start that NEVER settles) must react by stopping the endpoint and deleting the gate
  // project promptly. gateTimeoutMs (test-only override, prod default 90s) keeps this determin-
  // istic without faking timers around the pipeline's real fs work.
  it("gate timeout aborts the in-flight validate: the REAL runner's cleanup deletes the gate project — no leak until boot sweep", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci } = fakeOci();

    const now = new Date().toISOString();
    const project: ProjectRow = {
      id: "gate-proj", name: "_devdb_validate_deadbeef", pgVersion: 17 as ProjectRow["pgVersion"],
      createdAt: now, updatedAt: now,
    };
    const mainBranch: BranchRow = {
      id: "gate-branch", projectId: project.id, parentBranchId: null, name: "main", slug: "main-abc123",
      timelineId: "tl-1", password: "pw", stickyPort: null, endpointStatus: "stopped",
      endpointError: null, importStatus: "none", importError: null, createdBy: "api",
      context: null, createdAt: now, updatedAt: now,
    };
    const deleteSpy = vi.fn(async (_id: string) => {});
    const stopSpy = vi.fn(async (_branchId: string) =>
      ({} as Awaited<ReturnType<EndpointsService["stop"]>>));
    const projects: Pick<ProjectsService, "create" | "delete" | "list"> = {
      create: vi.fn(async (_a: { name: string; pgVersion?: number }) => ({ project, mainBranch })),
      delete: deleteSpy,
      list: vi.fn((): ProjectRow[] => []),
    };
    const endpoints: Pick<EndpointsService, "startWithPgbin" | "stop"> = {
      // A compute start that never settles — the worst-case hung step the abort must cut through.
      startWithPgbin: vi.fn((_branchId: string, _pgbinPath: string) =>
        new Promise<Awaited<ReturnType<EndpointsService["startWithPgbin"]>>>(() => {})),
      stop: stopSpy,
    };
    const validate = makeValidationRunner({
      projects, endpoints,
      sql: { run: vi.fn(async (_branchId: string, _query: string) => {
        throw new Error("unreachable — the start step never resolved");
      }) },
      logger: noopLogger,
    });
    const { state, provisioner } = makeProvisioner({ install, builds, oci, validate, gateTimeoutMs: 80 });

    const { buildId } = await provisioner.pull({ major: 17 });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("failed");
      return r!;
    });
    expect(row.error).toMatch(/gate timed out/);
    await expect(access(row.path)).rejects.toThrow(); // extracted dir rm'd, as before

    // THE fix: the runner's cleanup ran even though its current step never settled — the gate
    // project was deleted (and its endpoint stopped) right at the timeout, not leaked.
    await vi.waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
    expect(deleteSpy).toHaveBeenCalledWith(project.id);
    expect(stopSpy).toHaveBeenCalledWith(mainBranch.id);
  });

  it("check(): isNew digest reported; updateAvailableFor exposes short digest; known digest → isNew false", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    // Per-major digest: 17's `latest` resolves to a digest never seen before (isNew); 16's
    // resolves to DIGEST_A, which a pre-existing ready row below already claims (not new).
    const oci: OciPuller = {
      resolveDigest: async (repo) => ({ digest: repo.includes("v16") ? DIGEST_A : DIGEST_B }),
      pullPrefix: async () => { throw new Error("check() must never call pullPrefix"); },
    };
    const { state, provisioner } = makeProvisioner({ install, builds, oci });

    state.pgBuilds.insert({
      id: "existing-16", major: 16, minor: 9, source: "downloaded", releaseTag: "8000",
      imageDigest: DIGEST_A, path: join(builds, "v16", "8000"), status: "ready",
    });

    const result = await provisioner.check([16, 17]);

    expect(result["17"]).toMatchObject({ tag: "latest", digest: DIGEST_B, isNew: true });
    expect(result["16"]).toMatchObject({ tag: "latest", digest: DIGEST_A, isNew: false });

    expect(provisioner.updateAvailableFor(17)).toBe(`latest@${DIGEST_B.slice(7, 19)}`);
    expect(provisioner.updateAvailableFor(16)).toBeNull();
  });

  it("check(): a FAILED row at the current digest does not count as installed — isNew stays true", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    // 17's `latest` resolves to DIGEST_A — the only row at that digest is `failed` (e.g. a prior
    // gate failure or a non-409 activate malfunction). byDigest is ready-preferred: absent a ready
    // row it still returns this failed one, so check() must not mistake "a row exists" for
    // "installed" — nothing is actually on disk for this digest.
    const { oci } = fakeOci({ digest: DIGEST_A });
    const { state, provisioner } = makeProvisioner({ install, builds, oci });

    state.pgBuilds.insert({
      id: "failed-17", major: 17, minor: null, source: "downloaded", releaseTag: "latest",
      imageDigest: DIGEST_A, path: "", status: "failed",
    });

    const result = await provisioner.check([17]);

    expect(result["17"]).toMatchObject({ tag: "latest", digest: DIGEST_A, isNew: true });
    expect(provisioner.updateAvailableFor(17)).toBe(`latest@${DIGEST_A.slice(7, 19)}`);
  });

  // Fix round 1 (review of Task 10 commit 3bfc859, Fix #2, P3): build-mutating operations
  // (activate/remove) were not serialized — only pulls were, via the private `pulling` flag.
  // remove(id) calls assertRemovable synchronously then `await rm(row.path)`; during that await,
  // a concurrent activate(id) for the SAME row could flip it active + recompose, and the delete
  // then removes the just-activated build out from under it, stranding the major (the row is
  // gone from both disk AND SQLite, but was "active" the instant before deletion — no ready
  // build left for its major until GC/reboot picks another). The fix adds a mutation-lane
  // serializer (runMutation) so activate/remove never interleave.
  describe("mutation lane (activate/remove serialization)", () => {
    it("remove(id) held on a slow rm, concurrent activate(id) on the SAME row — the lane serializes them: never a deleted-but-active row", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      const { oci } = fakeOci();
      const { state, registry, provisioner } = makeProvisioner({ install, builds, oci });

      // Seed a single ready, non-active downloaded v17 build — removable (not baked, not active,
      // not in-flight, not in-use) at the moment remove() starts.
      const dir = await fakeVolumeBuild(builds, 17, "t1",
        { digest: DIGEST_A, tag: "t1", major: 17, minor: 5, extractedAt: "x" });
      state.pgBuilds.insert({
        id: "b1", major: 17, minor: 5, source: "downloaded", releaseTag: "t1",
        imageDigest: DIGEST_A, path: dir, status: "ready",
      });

      // Hold remove()'s rm() open until released — this is the window a pre-fix concurrent
      // activate() could interleave into.
      let releaseRm!: () => void;
      const rmGate = new Promise<void>((res) => { releaseRm = res; });
      rmMock.mockImplementationOnce(async (...args: Parameters<typeof realFs.rm>) => {
        await rmGate;
        return realFs.rm(...args);
      });

      const removePromise = provisioner.remove("b1", []);
      // Give remove() a tick to reach (and block inside) rm().
      await vi.waitFor(() => expect(rmMock).toHaveBeenCalled());

      // Concurrent activate() on the SAME row, issued while remove() is still mid-flight.
      const activatePromise = provisioner.activate("b1");

      releaseRm();
      const [removeResult, activateResult] = await Promise.allSettled([removePromise, activatePromise]);

      // Whichever ordering the lane picked, the end state must be single and consistent: either
      // the row was fully removed (activate then correctly sees "no such build", 404) and NOTHING
      // is left active/on-disk claiming to be b1, OR activate ran to completion first and remove
      // then genuinely 409s on "is the active build" (never silently deleting an active row).
      // What must NEVER happen: both "succeed" with b1 ending up deleted from SQLite while some
      // active pointer/on-disk state still references it.
      const stillThere = state.pgBuilds.byId("b1");
      if (removeResult.status === "fulfilled") {
        // remove() won the lane: b1 is gone. activate() must have failed with 404 (ran after
        // deletion) — never "succeeded" against a row that no longer exists.
        expect(stillThere).toBeNull();
        expect(activateResult.status).toBe("rejected");
        if (activateResult.status === "rejected") {
          expect(activateResult.reason).toBeInstanceOf(DevdbError);
          expect((activateResult.reason as DevdbError).statusCode).toBe(404);
        }
      } else {
        // activate() won the lane: b1 is active and ready. remove() must have then failed with
        // the registry's real "is the active build" 409 — never proceeding to delete it.
        expect(activateResult.status).toBe("fulfilled");
        expect(stillThere).toMatchObject({ id: "b1", active: true, status: "ready" });
        expect(removeResult.status).toBe("rejected");
        if (removeResult.status === "rejected") {
          expect(removeResult.reason).toBeInstanceOf(DevdbError);
          expect((removeResult.reason as DevdbError).message).toMatch(/active build/);
        }
        // The dir must still be on disk too — remove() must not have touched it.
        await access(dir);
      }
    });

    it("Provisioner.activate() runs registry.activate + recomposeDistrib + publish, and returns the activated row", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      await fakeInstallDir(install, "v17"); // baked v17
      const { oci } = fakeOci();
      const { registry, provisioner, events, recomposeDistrib } = makeProvisioner({ install, builds, oci });
      await registry.seedBaked();
      registry.resolveActives();
      const bakedId = registry.list().find((r) => r.source === "baked")!.id;

      const collected: DevdbEvent[] = [];
      events.subscribe((e) => collected.push(e));

      const row = await provisioner.activate(bakedId);

      expect(row.id).toBe(bakedId);
      expect(row.active).toBe(true);
      expect(recomposeDistrib).toHaveBeenCalledTimes(1);
      expect(collected.some((e) => e.type === "pg_builds")).toBe(true);
    });

    it("Provisioner.activate() on an unknown id rejects with the registry's 404, not silently", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      const { oci } = fakeOci();
      const { provisioner } = makeProvisioner({ install, builds, oci });

      await expect(provisioner.activate("no-such-build")).rejects.toThrow(DevdbError);
    });
  });

  // Fix round 2 (review of Fix round 1's post-activate compensation): runPipeline's outer catch
  // restores a stranded major's active pointer after a post-activate failure (recomposeDistrib
  // throwing). Originally it called registry.resolveActives() directly — un-serialized against the
  // mutation lane AND global (every major re-picked). These tests pin the three ways that bit:
  // over-reach across majors, a strand racing a concurrent remove, and clobbering a concurrent
  // explicit activate. The fix lanes the recovery, guards it on "this major currently lacks an
  // active ready build", and scopes it to the failed major via registry.resolveActiveFor().
  describe("post-activate failure recovery (laned, guarded, major-scoped)", () => {
    it("recovery must NOT re-pick an unrelated, explicitly-pinned major (scoped, not global)", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      await fakeInstallDir(install, "v17"); // baked v17 (minor 5) — major 17's recovery target
      const { oci } = fakeOci(); // the v17 pull resolves DIGEST_A
      const { state, registry, provisioner, recomposeDistrib } = makeProvisioner({ install, builds, oci });
      await registry.seedBaked();
      registry.resolveActives(); // baked-v17 active

      // Major 16: two ready downloaded builds; the operator has deliberately PINNED the older one
      // (p16-old, a known-good version) while a newer p16-new sits installed but unused.
      const DIGEST_C = "sha256:" + "c".repeat(64);
      const DIGEST_D = "sha256:" + "d".repeat(64);
      state.pgBuilds.insert({ id: "p16-old", major: 16, minor: 3, source: "downloaded", releaseTag: "old",
        imageDigest: DIGEST_C, path: join(builds, "v16", "old"), status: "ready" });
      state.pgBuilds.insert({ id: "p16-new", major: 16, minor: 9, source: "downloaded", releaseTag: "new",
        imageDigest: DIGEST_D, path: join(builds, "v16", "new"), status: "ready" });
      state.pgBuilds.setActiveExclusive("p16-old");
      expect(registry.pgbinFor(16).buildId).toBe("p16-old");

      // A v17 pull that activates, then fails in recomposeDistrib — the post-activate recovery path.
      recomposeDistrib.mockRejectedValueOnce(new Error("recomposeDistrib: symlink farm rebuild failed"));
      const { buildId } = await provisioner.pull({ major: 17 });
      await vi.waitFor(() => expect(state.pgBuilds.byId(buildId)?.status).toBe("failed"));
      // 17 itself recovers to baked in BOTH old and new code — wait on that so the recovery has run.
      await vi.waitFor(() => expect(registry.pgbinFor(17).buildId).toBe("baked-v17"));

      // The point: major 16 was untouched. A global resolveActives() re-picks EVERY major and would
      // have flipped 16 to the newest (p16-new), silently discarding the operator's pin because an
      // ENTIRELY UNRELATED major's pull failed. The scoped recovery only re-resolves major 17.
      expect(registry.pgbinFor(16).buildId).toBe("p16-old");
      expect(state.pgBuilds.byId("p16-new")?.active).toBe(false);
    });

    it("recovery racing a laned remove of the newest ready build — deferred behind the remove, major not stranded", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      await fakeInstallDir(install, "v17"); // baked v17 (minor 5)
      const { oci } = fakeOci(); // the pull resolves DIGEST_A → finalDir v17/SHORT_A
      const { state, registry, provisioner, recomposeDistrib } = makeProvisioner({ install, builds, oci });
      await registry.seedBaked();
      registry.resolveActives(); // baked-v17 active

      // d1: the NEWEST ready build for 17 (minor 6 > baked 5) but not active. Once the pull row is
      // marked failed, d1 is momentarily the newest-ready AND non-active — both removable AND what
      // an unconditional resolveActives() would elect as 17's active pointer.
      const d1Dir = await fakeVolumeBuild(builds, 17, "d1",
        { digest: DIGEST_B, tag: "d1", major: 17, minor: 6, extractedAt: "x" });
      state.pgBuilds.insert({ id: "d1", major: 17, minor: 6, source: "downloaded", releaseTag: "d1",
        imageDigest: DIGEST_B, path: d1Dir, status: "ready" });

      // Hold the pull's auto-activate open inside recomposeDistrib so a concurrent remove can chain
      // behind the in-flight mutation before the failure fires.
      let rejectRecompose!: (e: Error) => void;
      recomposeDistrib.mockImplementationOnce(() => new Promise((_res, rej) => { rejectRecompose = rej; }));

      // Path-routed rm: independently hold d1's removal (the window remove() suspends in) and the
      // catch's finalDir removal; no-op both (the SQLite delete still runs) and pass everything else
      // through so afterEach cleanup works.
      const finalDir = join(builds, "v17", SHORT_A);
      let releaseD1!: () => void;
      const d1Gate = new Promise<void>((res) => { releaseD1 = res; });
      let releaseFinalDirRm!: () => void;
      const finalDirRmGate = new Promise<void>((res) => { releaseFinalDirRm = res; });
      rmMock.mockImplementation(async (...args: Parameters<typeof realFs.rm>) => {
        const p = args[0];
        if (p === d1Dir) { await d1Gate; return; }
        if (p === finalDir) { await finalDirRmGate; return; }
        return realFs.rm(...args);
      });

      const { buildId } = await provisioner.pull({ major: 17 });
      await vi.waitFor(() => expect(recomposeDistrib).toHaveBeenCalled()); // auto-activate suspended, activatedRef true

      const removePromise = provisioner.remove("d1", []); // chains behind the in-flight mutation
      rejectRecompose(new Error("recomposeDistrib: symlink farm rebuild failed"));
      // remove() is now blocked inside rm(d1) and the pull row is failed → the catch is suspended at
      // its own gated finalDir rm, just before the recovery point.
      await vi.waitFor(() => {
        expect(rmMock).toHaveBeenCalledWith(d1Dir, expect.anything());
        expect(state.pgBuilds.byId(buildId)?.status).toBe("failed");
      });

      releaseFinalDirRm();
      await new Promise((r) => setImmediate(r)); // drain: pre-fix, the un-laned resolveActives() elects d1 here

      releaseD1();
      await removePromise; // remove() deletes d1

      // Invariant: 17 must still have an active READY build. Pre-fix the un-laned recovery elected
      // d1, then remove deleted it out from under the pointer → no active ready row → pgbinFor 409s
      // (stranded). Fixed: recovery ran AFTER remove on the lane, saw 17 stranded, re-picked baked.
      await vi.waitFor(() => expect(registry.pgbinFor(17).buildId).toBe("baked-v17"));
      expect(state.pgBuilds.byId("d1")).toBeNull();
      expect(state.pgBuilds.byId(buildId)).toMatchObject({ status: "failed", active: false });
    });

    it("recovery racing a laned activate of a non-newest build — the guard leaves the explicit pick intact", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      await fakeInstallDir(install, "v17"); // baked v17 (minor 5)
      const { oci } = fakeOci();
      const { state, registry, provisioner, recomposeDistrib } = makeProvisioner({ install, builds, oci });
      await registry.seedBaked();
      registry.resolveActives(); // baked-v17 active

      // d1: a ready but NON-newest build (minor 4 < baked 5). An operator explicitly activates it
      // concurrently with the failing pull. An unconditional recovery re-picks baked (newest) and
      // clobbers the deliberate choice; the guard must see 17 already has an active ready build.
      const d1Dir = await fakeVolumeBuild(builds, 17, "d1",
        { digest: DIGEST_B, tag: "d1", major: 17, minor: 4, extractedAt: "x" });
      state.pgBuilds.insert({ id: "d1", major: 17, minor: 4, source: "downloaded", releaseTag: "d1",
        imageDigest: DIGEST_B, path: d1Dir, status: "ready" });

      let rejectRecompose!: (e: Error) => void;
      recomposeDistrib.mockImplementationOnce(() => new Promise((_res, rej) => { rejectRecompose = rej; }));

      const finalDir = join(builds, "v17", SHORT_A);
      let releaseFinalDirRm!: () => void;
      const finalDirRmGate = new Promise<void>((res) => { releaseFinalDirRm = res; });
      rmMock.mockImplementation(async (...args: Parameters<typeof realFs.rm>) => {
        const p = args[0];
        if (p === finalDir) { await finalDirRmGate; return; }
        return realFs.rm(...args);
      });

      const { buildId } = await provisioner.pull({ major: 17 });
      await vi.waitFor(() => expect(recomposeDistrib).toHaveBeenCalled()); // auto-activate suspended

      const activatePromise = provisioner.activate("d1"); // chains behind the in-flight mutation
      rejectRecompose(new Error("recomposeDistrib: symlink farm rebuild failed"));
      // Wait until the explicit activate has committed (d1 active) AND the pull row is failed (catch
      // entered) — the catch is now suspended at its gated finalDir rm, before the recovery point.
      await vi.waitFor(() => {
        expect(state.pgBuilds.byId("d1")?.active).toBe(true);
        expect(state.pgBuilds.byId(buildId)?.status).toBe("failed");
      });

      releaseFinalDirRm();
      await new Promise((r) => setImmediate(r)); // drain: pre-fix, the un-laned resolveActives() clobbers d1 here
      await activatePromise;
      await new Promise((r) => setImmediate(r)); // let any laned recovery settle

      // The explicit pick survives: d1 stays active (the guard saw an active ready build and did
      // nothing). Pre-fix, resolveActives re-picked baked (5 > 4), silently discarding the choice.
      expect(registry.pgbinFor(17).buildId).toBe("d1");
      expect(state.pgBuilds.byId("baked-v17")?.active).toBe(false);
    });
  });
});
