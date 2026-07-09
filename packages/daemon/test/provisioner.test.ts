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

// Same-version dedup (extractFixupAndGate) no-ops a pull whose detected minor already exists as a
// ready build of that major. Tests that seed a BAKED v17 and then pull v17 must give the pulled
// build a DIFFERENT minor than the baked one, or the pull dedups before reaching what it exercises
// (gate / activate / recompose / compensation). This factory returns a path-aware detectVersion —
// makeProvisioner hands the SAME fn to BuildRegistry (baked detection, probes under the install
// dir) and the Provisioner (pull detection, probes under the builds/tmp dir), so a check on whether
// the pgbin lives under `builds` cleanly separates them: pulled ⇒ pulledMinor, baked ⇒ bakedMinor.
// Default pulledMinor is 7 (not 6) so it also clears the minor-6 downloaded `d1` rows some of these
// tests pre-seed alongside the baked-5 build.
function pathAwareDetectVersion(
  builds: string, opts: { pulledMinor?: number; bakedMinor?: number } = {},
): (pgbin: string) => Promise<{ major: number; minor: number }> {
  const pulledMinor = opts.pulledMinor ?? 7;
  const bakedMinor = opts.bakedMinor ?? 5;
  return async (pgbin) => ({ major: 17, minor: pgbin.startsWith(builds) ? pulledMinor : bakedMinor });
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
      // Pulled build detects a DIFFERENT minor (17.7) than the baked (17.5), so the same-version
      // dedup doesn't no-op it before it reaches the gate this test is exercising.
      detectVersion: pathAwareDetectVersion(builds),
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

  it('digest dedup: already-installed digest → row SKIPPED (benign) with "already installed" and NO oci.pullPrefix call', async () => {
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

    // A no-op is a benign "skipped", NOT "failed" — the UI must not alarm or offer a Retry that
    // just re-no-ops. The dedup guard itself is unchanged (pullPrefix never runs).
    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("skipped");
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

  it("incompatible build (detectVersion load-failure) → failed row, staging dir reclaimed, path cleared", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci } = fakeOci();
    const { state, provisioner } = makeProvisioner({
      install, builds, oci,
      // What version.ts surfaces when the dynamic linker can't resolve the pulled binary's libs
      // (a build linked against a different OS base than this runtime). It THROWS — unlike the
      // detected-major MISMATCH above, which returns after cleaning up — so it takes the pipeline's
      // outer-catch path, which must still reclaim the pre-rename staging dir and drop the claim.
      detectVersion: async (pgbin) => {
        throw new Error(
          `${pgbin} is incompatible with this runtime image (missing shared library libssl.so.1.1) — the build targets a different OS base than this container`,
        );
      },
    });

    const { buildId } = await provisioner.pull({ major: 17 });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("failed");
      return r!;
    });
    expect(row.error).toMatch(/incompatible with this runtime image/);
    expect(row.error).toMatch(/libssl\.so\.1\.1/);
    // The fully-extracted ~200 MB staging dir must NOT be left behind for the next-boot sweep.
    await expect(access(join(builds, "v17", `.tmp-${SHORT_A}`))).rejects.toThrow();
    // And the row must drop its claim on the now-deleted staging path (so a same-digest retry, or
    // a later DELETE of this failed row, can't collide with / rm a live dir — mirrors the gate path).
    expect(row.path).toBe("");
  });

  it("staging rm failure KEEPS the row's path claim (recoverable via DELETE, not falsely cleared)", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci } = fakeOci();
    const { state, provisioner } = makeProvisioner({
      install, builds, oci,
      detectVersion: async (pgbin) => {
        throw new Error(`${pgbin} is incompatible with this runtime image (missing shared library libssl.so.1.1) — the build targets a different OS base than this container`);
      },
    });
    // Make ONLY the staging-dir rm reject; every other rm (none on this path) stays real. A false
    // "success" would clear the path even though the .tmp- dir is still on disk — the P4 regression.
    rmMock.mockImplementation((p: Parameters<typeof realFs.rm>[0], opts: Parameters<typeof realFs.rm>[1]) =>
      String(p).includes(".tmp-") ? Promise.reject(new Error("EBUSY: simulated rm failure")) : realFs.rm(p, opts));

    const { buildId } = await provisioner.pull({ major: 17 });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("failed");
      return r!;
    });
    // rm failed ⇒ the row must KEEP its claim on the staging path so a later DELETE can reclaim it.
    expect(row.path).toBe(join(builds, "v17", `.tmp-${SHORT_A}`));
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

  // HARD-2 (hardening pass, P2 — supersedes Fix round 1's expectation for THIS trigger): a
  // recomposeDistrib failure AFTER the gate passed and the build was activated used to fire the
  // outer catch's full compensation — setStatus(failed) + rm finalDir + path-clear +
  // resolveActiveFor — DESTROYING a valid, gate-passed build and reverting the major to an older
  // build over a transient farm hiccup (e.g. ENOSPC mid symlink rebuild). And if an endpoint had
  // started on the new build in the activate→recompose window (pgbinFor is not laned), the rm
  // yanked a live compute's --pgbin dir. The farm is the SELF-HEALING part (composePgDistrib
  // re-derives everything from the registry on every call; boot recomposes before engine.start)
  // — the build itself is final the moment the gate passes and the activation outcome commits.
  // The recompose failure is now swallowed at its call site: build stays ready + active, pointer
  // untouched, failure logged loudly on the build's channel, job recorded done.
  it("HARD-2: recompose failure after gate+activate keeps the build ready+active — no rm, no pointer revert, failure logged", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    await fakeInstallDir(install, "v17"); // baked v17, seeded + active (the would-be revert target)
    const { oci } = fakeOci();
    // Pulled build detects 17.7 (≠ baked 17.5) so it isn't dedup-no-op'd before it activates.
    const { state, registry, logs, provisioner, recomposeDistrib } = makeProvisioner({
      install, builds, oci, detectVersion: pathAwareDetectVersion(builds),
    });
    await registry.seedBaked();
    registry.resolveActives(); // baked-v17 active
    expect(registry.pgbinFor(17).buildId).toBe("baked-v17");

    // activate() succeeds; the failure happens strictly AFTER activation, in recomposeDistrib.
    recomposeDistrib.mockRejectedValueOnce(new Error("recomposeDistrib: symlink farm rebuild failed"));

    const { buildId } = await provisioner.pull({ major: 17 });

    // Terminal signal in both worlds: the pull job settles. Post-fix it settles "done" — the
    // install itself succeeded; only the self-healing farm step hiccuped. (Pre-fix: "failed",
    // with the row destroyed and the pointer reverted.)
    await vi.waitFor(() => {
      const job = state.raw.prepare("SELECT status FROM jobs WHERE kind = 'pg_build_pull'").get() as { status: string };
      expect(job.status).not.toBe("running");
    });
    const job = state.raw.prepare("SELECT status FROM jobs WHERE kind = 'pg_build_pull'").get() as { status: string };
    expect(job.status).toBe("done");

    const row = state.pgBuilds.byId(buildId)!;
    expect(row).toMatchObject({ status: "ready", active: true, error: null });
    await access(join(row.path, "bin", "postgres")); // dir intact — nothing rm'd
    expect(state.pgBuilds.byId("baked-v17")?.active).toBe(false); // pointer NOT reverted
    expect(registry.pgbinFor(17).buildId).toBe(buildId); // endpoints resolve the NEW build
    // The failure is loud on the build's log channel, not silently swallowed.
    const tail = logs.recent(`pgbuild:${buildId}`);
    expect(tail.some((l) => l.includes("symlink farm rebuild failed"))).toBe(true);
  });

  // HARD-2 companion: a deliberate downgrade re-pull leaves the build ready-but-INACTIVE (the
  // activate 409 is tolerated, the old pointer intact) — a recompose failure right after must not
  // destroy that valid build either. The same call-site swallow covers both activation outcomes:
  // the build's fate is committed BEFORE recomposeDistrib runs, whichever branch it took.
  it("HARD-2: recompose failure after a tolerated activate-409 keeps the build ready (inactive), dir intact", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    const { oci } = fakeOci();
    const { state, registry, provisioner, recomposeDistrib } = makeProvisioner({ install, builds, oci });
    vi.spyOn(registry, "activate").mockImplementation(() => {
      throw new DevdbError(409, "activating 17.5 would downgrade below the last-run 17.9");
    });
    recomposeDistrib.mockRejectedValueOnce(new Error("recomposeDistrib: symlink farm rebuild failed"));

    const { buildId } = await provisioner.pull({ major: 17 });

    await vi.waitFor(() => {
      const job = state.raw.prepare("SELECT status FROM jobs WHERE kind = 'pg_build_pull'").get() as { status: string };
      expect(job.status).not.toBe("running");
    });
    const job = state.raw.prepare("SELECT status FROM jobs WHERE kind = 'pg_build_pull'").get() as { status: string };
    expect(job.status).toBe("done");

    const row = state.pgBuilds.byId(buildId)!;
    expect(row).toMatchObject({ status: "ready", active: false, error: null });
    await access(join(row.path, "bin", "postgres")); // the valid ready-but-inactive build survives
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

    // 17's latest digest is unknown ⇒ "unverified" (we can't confirm it's newer without a pull),
    // NOT a confident "update available". 16's resolves to an installed-ready digest ⇒ "current".
    expect(result["17"]).toMatchObject({ tag: "latest", digest: DIGEST_B, state: "unverified", isNew: true });
    expect(result["16"]).toMatchObject({ tag: "latest", digest: DIGEST_A, state: "current", isNew: false });

    expect(provisioner.updateAvailableFor(17)).toBe(`latest@${DIGEST_B.slice(7, 19)}`);
    expect(provisioner.updateAvailableFor(16)).toBeNull();
  });

  it("check(): a TRANSIENTLY-failed row at the current digest stays offerable — state unverified, isNew true", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    // 17's `latest` resolves to DIGEST_A — the only row at that digest is `failed` for a NON-base
    // reason (a gate timeout / a non-409 activate malfunction; error not an incompatibility). byDigest
    // is ready-preferred: absent a ready row it still returns this failed one, so check() must not
    // mistake "a row exists" for "installed" — nothing is on disk. A transient failure might yet
    // install a genuine newer minor on retry, so it stays "unverified" (offerable), not suppressed.
    const { oci } = fakeOci({ digest: DIGEST_A });
    const { state, provisioner } = makeProvisioner({ install, builds, oci });

    state.pgBuilds.insert({
      id: "failed-17", major: 17, minor: null, source: "downloaded", releaseTag: "latest",
      imageDigest: DIGEST_A, path: "", status: "failed",
    });
    state.pgBuilds.setStatus("failed-17", "failed", "gate timed out after 90s");

    const result = await provisioner.check([17]);

    expect(result["17"]).toMatchObject({ tag: "latest", digest: DIGEST_A, state: "unverified", isNew: true });
    expect(provisioner.updateAvailableFor(17)).toBe(`latest@${DIGEST_A.slice(7, 19)}`);
  });

  it("check(): an INCOMPATIBLE failed row at the current digest is not an update — state incompatible, isNew false", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    // 16's `latest` resolves to DIGEST_A, whose only row is a pull that FAILED TO LOAD (a bullseye
    // compute-node — libssl.so.1.1 — on the bookworm runtime). The incompatibility is permanent for
    // this runtime: re-pulling DIGEST_A re-fails identically, so it is NOT an available update. The
    // over-eager pre-fix check flagged it forever (the very image that just failed to load).
    const oci: OciPuller = {
      resolveDigest: async () => ({ digest: DIGEST_A }),
      pullPrefix: async () => { throw new Error("check() must never pull"); },
    };
    const { state, provisioner } = makeProvisioner({ install, builds, oci });

    state.pgBuilds.insert({
      id: "incompat-16", major: 16, minor: null, source: "downloaded", releaseTag: "latest",
      imageDigest: DIGEST_A, path: "", status: "failed",
    });
    state.pgBuilds.setStatus("incompat-16", "failed",
      "/data/pg_builds/v16/.tmp-aaaa/bin/postgres is incompatible with this runtime image "
      + "(missing shared library libssl.so.1.1) — the build targets a different OS base than this container");

    const result = await provisioner.check([16]);

    expect(result["16"]).toMatchObject({ tag: "latest", digest: DIGEST_A, state: "incompatible", isNew: false });
    expect(provisioner.updateAvailableFor(16)).toBeNull();
  });

  // Same-version dedup (the fix): a baked build carries the '' digest sentinel, so `latest`
  // resolving to a NEW digest that turns out to be the SAME minor already baked never digest-matches
  // — it reaches the version dedup in extractFixupAndGate and must no-op there rather than install a
  // redundant second build of the identical version (which would make Activate a confusing toggle
  // between two 17.5s). The baked build keeps its default detectVersion minor (17.5); the pulled
  // build detects the SAME minor (default makeProvisioner detectVersion returns 17.5 regardless of
  // path), so the dedup fires.
  it("same-minor pull is a no-op: no duplicate build", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    await fakeInstallDir(install, "v17"); // baked v17 → seedBaked detects minor 5
    const { oci } = fakeOci({ digest: DIGEST_A }); // a real digest, NOT the baked '' sentinel
    const { state, registry, provisioner } = makeProvisioner({ install, builds, oci });
    await registry.seedBaked();
    registry.resolveActives(); // baked-v17 (17.5) active

    const { buildId } = await provisioner.pull({ major: 17 });

    const row = await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("skipped");
      return r!;
    });
    // The pull no-op'd against the already-installed 17.5 — recording the source it collided with.
    expect(row.error).toMatch(/already installed as 17\.5/);
    // The digest→minor link is persisted on the skipped row (so check() can read it back), the
    // resolved digest survives, and the no-op row drops its path claim (owns no dir).
    expect(row.minor).toBe(5);
    expect(row.imageDigest).toBe(DIGEST_A);
    expect(row.path).toBe("");
    // Crucially: no duplicate ready build — only the baked one remains ready (and still active).
    const ready = state.pgBuilds.listByMajor(17).filter((b) => b.status === "ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ id: "baked-v17", active: true });
  });

  // The update-check counterpart of the fix: before the same-minor pull, the registry's `latest`
  // digest is genuinely unknown (no row carries it — the baked build has the '' sentinel), so isNew
  // is TRUE and the "update available" badge shows. After the same-minor pull no-ops, the failed row
  // records that digest→minor 5, and 17.5 is already installed ready (baked) — so the version-aware
  // check must now report isNew false and clear the badge, rather than perpetually offering an
  // "update" that resolves to a version you already run.
  it("update-check is version-aware", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    await fakeInstallDir(install, "v17"); // baked v17 (17.5)
    const { oci } = fakeOci({ digest: DIGEST_A });
    const { state, registry, provisioner } = makeProvisioner({ install, builds, oci });
    await registry.seedBaked();
    registry.resolveActives(); // baked-v17 (17.5) active

    // BEFORE any pull: DIGEST_A's version is unknown (baked carries ''), so the badge fires.
    expect(await provisioner.check([17])).toMatchObject({ "17": { isNew: true } });
    expect(provisioner.updateAvailableFor(17)).toBe(`latest@${DIGEST_A.slice(7, 19)}`);

    // The same-minor pull no-ops, recording DIGEST_A → minor 5 on the benign skipped row.
    const { buildId } = await provisioner.pull({ major: 17 });
    await vi.waitFor(() => {
      const r = state.pgBuilds.byId(buildId);
      expect(r?.status).toBe("skipped");
      expect(r?.minor).toBe(5);
    });

    // AFTER: the recorded digest→minor resolves to the already-ready baked 17.5 — current, no update.
    expect(await provisioner.check([17])).toMatchObject({ "17": { state: "current", isNew: false } });
    expect(provisioner.updateAvailableFor(17)).toBeNull();
  });

  // Skipped rows carry the digest→minor memory check() needs, so they PERSIST (we can't just delete
  // them) — but repeated no-op pulls at the same digest must not accumulate. recordSkip prunes older
  // skipped siblings at the same (major, digest), keeping exactly one. Reachable via direct API/MCP
  // force-pulls (agents-first): the honest check() stops the UI offering Pull for a current major,
  // but the guard still bounds the rows.
  it("repeated same-minor no-op pulls at the same digest keep exactly one skipped row (older pruned)", async () => {
    const { root, install, builds } = await scaffoldBuildDirs();
    dirs.push(root);
    await fakeInstallDir(install, "v17"); // baked v17 (17.5)
    const { oci } = fakeOci({ digest: DIGEST_A });
    const { state, registry, provisioner } = makeProvisioner({ install, builds, oci });
    await registry.seedBaked();
    registry.resolveActives(); // baked-v17 (17.5) active

    const { buildId: first } = await provisioner.pull({ major: 17 });
    await vi.waitFor(() => expect(state.pgBuilds.byId(first)?.status).toBe("skipped"));

    const { buildId: second } = await provisioner.pull({ major: 17 });
    await vi.waitFor(() => expect(state.pgBuilds.byId(second)?.status).toBe("skipped"));

    const skipped = state.pgBuilds.listByMajor(17).filter((b) => b.status === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.id).toBe(second);           // the newest no-op record survives
    expect(state.pgBuilds.byId(first)).toBeNull(); // the older duplicate was pruned
    // digest→minor memory intact ⇒ check() still reads the major as current.
    expect(await provisioner.check([17])).toMatchObject({ "17": { state: "current", isNew: false } });
    // The real ready build is untouched — still exactly the baked one, active.
    const ready = state.pgBuilds.listByMajor(17).filter((b) => b.status === "ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ id: "baked-v17", active: true });
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

      const removePromise = provisioner.remove("b1", () => []);
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

    // HARD-1 (hardening pass, P2): the DELETE route snapshots computes.runningPgbins() OUTSIDE
    // the lane; remove() then waits its turn behind any in-flight laned mutation and only
    // afterwards runs assertRemovable — whose in-use check consumed that frozen array while its
    // active/baked/status checks read the LIVE row (asymmetric). A build an endpoint started on
    // WHILE the DELETE was queued was still judged not-in-use and its dir rm'd out from under the
    // running compute (ENOENT on the live --pgbin). remove() now takes a SUPPLIER and reads it
    // inside the lane body, immediately before assertRemovable, so the in-use check is exactly as
    // live as the row checks.
    it("HARD-1: a build that became in-use while remove() was queued behind a laned mutation 409s — not rm'd under the running compute", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      await fakeInstallDir(install, "v17"); // baked v17 — the lane occupant's target
      const { oci } = fakeOci();
      const { state, registry, provisioner, recomposeDistrib } = makeProvisioner({ install, builds, oci });
      await registry.seedBaked();
      registry.resolveActives(); // baked-v17 active ⇒ b1 below is non-active (removable — for now)

      const dir = await fakeVolumeBuild(builds, 17, "b1",
        { digest: DIGEST_A, tag: "b1", major: 17, minor: 5, extractedAt: "x" });
      state.pgBuilds.insert({
        id: "b1", major: 17, minor: 5, source: "downloaded", releaseTag: "b1",
        imageDigest: DIGEST_A, path: dir, status: "ready",
      });

      // Pin the mutation lane: an explicit activate suspended inside ITS recomposeDistrib.
      let releaseOccupant!: () => void;
      recomposeDistrib.mockImplementationOnce(() => new Promise<void>((res) => { releaseOccupant = res; }));
      const occupant = provisioner.activate("baked-v17");
      await vi.waitFor(() => expect(recomposeDistrib).toHaveBeenCalledTimes(1)); // occupant mid-body

      // The DELETE arrives while the lane is busy: the running-pgbins source is empty right now.
      const running: string[] = [];
      const removePromise = provisioner.remove("b1", () => running);
      // …and WHILE remove() waits its turn, an endpoint starts on b1 (pgbinFor is not laned).
      running.push(join(dir, "bin", "postgres"));

      releaseOccupant();
      await occupant;

      // The in-use check must be evaluated at REMOVAL time, inside the lane: 409, nothing rm'd.
      const settled = await removePromise.then(() => "fulfilled" as const, (e: unknown) => e);
      expect(settled).toBeInstanceOf(DevdbError);
      expect((settled as DevdbError).statusCode).toBe(409);
      expect((settled as DevdbError).message).toMatch(/in use by a running endpoint/);
      expect(state.pgBuilds.byId("b1")).toMatchObject({ id: "b1", status: "ready" });
      await access(join(dir, "bin", "postgres")); // the running compute's dir survives
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

  // FIX-3 (final whole-branch review): a gate-failed attempt and its successful retry of the SAME
  // image share a digest ⇒ share a content-addressed path. The failed row used to keep
  // `path = finalDir` after the failure rm, and remove() rm'd `row.path` guarded only by
  // assertRemovable (a ROW check — it never asks whether another row claims the same path). So an
  // ordinary fail-then-retry followed by DELETE /api/pg-builds/{failedRowId} deleted the READY,
  // ACTIVE build's directory out from under it. Both halves are covered here: (a) failure paths
  // clear the row's stored path; (b) remove() skips the rm while a sibling row claims the path.
  describe("failure-path shared-dir safety (FIX-3)", () => {
    it("remove() of a failed row sharing the active build's path deletes the ROW but never the shared dir", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      const { oci } = fakeOci();
      const { state, registry, provisioner } = makeProvisioner({ install, builds, oci });
      // One real on-disk dir at the shared digest path. The failed attempt (rows created before
      // FIX-3(a), or any future gap) still claims path = finalDir; the retry re-extracted into the
      // very same digest-named dir and is now ready + active.
      const dir = await fakeVolumeBuild(builds, 17, SHORT_A,
        { digest: DIGEST_A, tag: "latest", major: 17, minor: 5, extractedAt: "x" });
      state.pgBuilds.insert({
        id: "failed-attempt", major: 17, minor: 5, source: "downloaded", releaseTag: "latest",
        imageDigest: DIGEST_A, path: dir, status: "failed",
      });
      state.pgBuilds.insert({
        id: "retry-ready", major: 17, minor: 5, source: "downloaded", releaseTag: "latest",
        imageDigest: DIGEST_A, path: dir, status: "ready",
      });
      state.pgBuilds.setActiveExclusive("retry-ready");

      await provisioner.remove("failed-attempt", () => []);

      expect(state.pgBuilds.byId("failed-attempt")).toBeNull(); // row cleanup still happens
      await access(join(dir, "bin", "postgres"));               // the active build's dir SURVIVES
      expect(registry.pgbinFor(17)).toMatchObject({ buildId: "retry-ready", path: join(dir, "bin", "postgres") });
    });

    it("remove() of the LAST row claiming a path still deletes the dir (no leak once no sibling claims it)", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      const { oci } = fakeOci();
      const { state, provisioner } = makeProvisioner({ install, builds, oci });
      const dir = await fakeVolumeBuild(builds, 17, SHORT_A,
        { digest: DIGEST_A, tag: "latest", major: 17, minor: 5, extractedAt: "x" });
      state.pgBuilds.insert({
        id: "only-claimant", major: 17, minor: 5, source: "downloaded", releaseTag: "latest",
        imageDigest: DIGEST_A, path: dir, status: "failed",
      });

      await provisioner.remove("only-claimant", () => []);

      expect(state.pgBuilds.byId("only-claimant")).toBeNull();
      await expect(access(dir)).rejects.toThrow(); // sole claimant ⇒ dir reclaimed as before
    });

    it("gate failure clears the row's stored path along with the rm (no stale claim on the digest dir)", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      const { oci } = fakeOci();
      const { state, provisioner } = makeProvisioner({
        install, builds, oci,
        validate: async () => { throw new Error("compute never became ready"); },
      });

      const { buildId } = await provisioner.pull({ major: 17 });

      const row = await vi.waitFor(() => {
        const r = state.pgBuilds.byId(buildId);
        expect(r?.status).toBe("failed");
        return r!;
      });
      expect(row.path).toBe(""); // a retry at the same digest owns the dir alone from here on
    });

    // HARD-2 retarget: the original trigger here (the auto-activate's recomposeDistrib throwing)
    // no longer fails the pipeline — that build is valid and KEPT (see the HARD-2 tests above).
    // The outer catch's rm + path-clear still exists for post-rename failures whose row fate is
    // genuinely unknown; the canonical reachable one is a non-409 registry.activate()
    // malfunction, so that is the trigger now. Same FIX-3(a) invariant as ever: a failure-rm'd
    // row must not keep claiming the digest-named dir a same-digest retry will re-create.
    it("post-ready pipeline failure (non-409 activate malfunction) clears the row's stored path after removing finalDir", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      await fakeInstallDir(install, "v17");
      const { oci } = fakeOci();
      // Pulled build detects 17.7 (≠ baked 17.5) so it reaches ACTIVATION rather than no-op'ing at
      // the same-minor dedup first — the activate malfunction below is the whole point of this test.
      // (Before benign-skip landed, a same-minor no-op set status "failed" too, so this test passed
      // for the wrong reason: it never reached activate. Now a no-op is "skipped", exposing that.)
      const { state, registry, provisioner } = makeProvisioner({
        install, builds, oci, detectVersion: pathAwareDetectVersion(builds),
      });
      await registry.seedBaked();
      registry.resolveActives();
      vi.spyOn(registry, "activate").mockImplementation(() => {
        throw new Error("sqlite: disk I/O error"); // a genuine malfunction, NOT a downgrade 409
      });

      const { buildId } = await provisioner.pull({ major: 17 });

      const row = await vi.waitFor(() => {
        const r = state.pgBuilds.byId(buildId);
        expect(r?.status).toBe("failed");
        return r!;
      });
      await vi.waitFor(() => expect(state.pgBuilds.byId(buildId)?.path).toBe(""));
      expect(row.id).toBe(buildId);
    });

    // Fable Minor #5, folded into FIX-3: the outer catch's finalDir rm used to run UN-LANED — it
    // could interleave with a concurrent laned activate() mid-body (between its registry.activate
    // and its recomposeDistrib), deleting a directory the activation is about to commit to. The
    // compensation's destructive half (rm + path-clear + pointer recovery) must queue through the
    // mutation lane so it strictly follows any in-flight activate/remove.
    //
    // HARD-2 retarget: the original trigger (the auto-activate's recomposeDistrib throwing) no
    // longer reaches the outer catch — the build is kept. This pin now drives the compensation
    // through a genuine PRE-ready failure that still owns a finalDir: the gate FAILS and the gate
    // catch's own rm(finalDir) ALSO throws, escalating to the outer catch with finalDirRef set.
    it("pre-ready failure compensation is laned: the rm waits out a concurrent laned activate mid-body", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      await fakeInstallDir(install, "v17"); // baked v17 (minor 5)
      const { oci } = fakeOci(); // DIGEST_A → finalDir v17/SHORT_A
      const { state, registry, provisioner, recomposeDistrib } = makeProvisioner({
        install, builds, oci,
        // Pulled build is 17.7 — distinct from BOTH the baked 17.5 and the seeded d1 17.6 below —
        // so the same-version dedup doesn't no-op it before the gate (which fails) is reached.
        detectVersion: pathAwareDetectVersion(builds),
        validate: async () => { throw new Error("compute never became ready"); }, // the gate fails
      });
      await registry.seedBaked();
      registry.resolveActives(); // baked-v17 active

      const d1Dir = await fakeVolumeBuild(builds, 17, "d1",
        { digest: DIGEST_B, tag: "d1", major: 17, minor: 6, extractedAt: "x" });
      state.pgBuilds.insert({ id: "d1", major: 17, minor: 6, source: "downloaded", releaseTag: "d1",
        imageDigest: DIGEST_B, path: d1Dir, status: "ready" });

      // The 1st rm(finalDir) — the GATE catch's cleanup — is held open, then made to THROW on
      // command (escalating into the outer catch); every later rm passes through to the real fs
      // (so the laned compensation's own rm(finalDir) actually deletes). The explicit activate's
      // recomposeDistrib is held open on command, pinning the lane mid-body.
      const finalDir = join(builds, "v17", SHORT_A);
      let failGateRm!: (e: Error) => void;
      const gateRmGate = new Promise<never>((_res, rej) => { failGateRm = rej; });
      let gateRmSeen = false;
      rmMock.mockImplementation(async (...args: Parameters<typeof realFs.rm>) => {
        if (args[0] === finalDir && !gateRmSeen) { gateRmSeen = true; return gateRmGate; }
        return realFs.rm(...args);
      });
      let releaseActivateRecompose!: () => void;
      recomposeDistrib.mockImplementationOnce(() => new Promise<void>((res) => { releaseActivateRecompose = res; }));

      const { buildId } = await provisioner.pull({ major: 17 });
      // The pull is now suspended INSIDE the gate catch's rm — upstream of the outer catch.
      await vi.waitFor(() => expect(gateRmSeen).toBe(true));

      const activatePromise = provisioner.activate("d1"); // takes the (empty) lane, suspends in ITS recompose
      await vi.waitFor(() => expect(recomposeDistrib).toHaveBeenCalledTimes(1));
      failGateRm(new Error("EBUSY: gate cleanup rm failed")); // outer catch entered; compensation queues BEHIND d1's activate

      // The failure is recorded immediately (status flip is not destructive — not lane-gated)…
      await vi.waitFor(() => expect(state.pgBuilds.byId(buildId)?.status).toBe("failed"));
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); // drain any un-laned rm

      // THE pin: while a laned mutation is mid-body, the compensation's rm must NOT have run yet.
      await access(join(finalDir, "bin", "postgres")); // pre-Minor-#5: already deleted at this point

      releaseActivateRecompose();
      await activatePromise; // d1 committed by the explicit activate
      // Now the laned compensation runs: dir removed, path cleared. activatedRef stayed false
      // (the pull never reached activation), so the pointer half doesn't run — d1 stays active.
      await vi.waitFor(async () => { await expect(access(finalDir)).rejects.toThrow(); });
      expect(state.pgBuilds.byId(buildId)).toMatchObject({ status: "failed", path: "", active: false });
      expect(registry.pgbinFor(17).buildId).toBe("d1");
    });
  });

  // Fix round 2 originally pinned the post-activate POINTER RECOVERY (the laned, guarded,
  // major-scoped resolveActiveFor) that ran when the auto-activate's recomposeDistrib threw.
  // HARD-2 (hardening pass) removed that trigger entirely: a recompose failure after the gate
  // passed and the activation outcome committed no longer fails the row or reverts anything —
  // the build is valid and KEPT (see the HARD-2 tests above), and the farm self-heals. The
  // recovery code itself remains in runPipeline's catch as an unreachable-in-practice backstop
  // (log()/publish() swallow by contract, so nothing after activation can throw today). These
  // tests re-pin the SAME concurrent choreographies under the new semantics: a swallowed
  // recompose failure must leave the mutation lane live and must not disturb queued mutations,
  // unrelated majors, or the new build's pointer.
  describe("post-gate recompose failure under concurrent laned mutations (HARD-2)", () => {
    it("a swallowed recompose failure touches NO pointer: the pulled major keeps its new build; an unrelated pinned major is untouched", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      await fakeInstallDir(install, "v17"); // baked v17 (minor 5) — the would-be revert target
      const { oci } = fakeOci(); // the v17 pull resolves DIGEST_A
      // Pulled v17 build detects 17.7 (≠ baked 17.5) so it isn't dedup-no-op'd before it activates.
      const { state, registry, provisioner, recomposeDistrib } = makeProvisioner({
        install, builds, oci, detectVersion: pathAwareDetectVersion(builds),
      });
      await registry.seedBaked();
      registry.resolveActives(); // baked-v17 active

      // Major 16: two ready downloaded builds; the operator has deliberately PINNED the older one
      // (p16-old, a known-good version) while a newer p16-new sits installed but unused. The old
      // GLOBAL resolveActives() recovery would have flipped 16 to p16-new over 17's failure.
      const DIGEST_C = "sha256:" + "c".repeat(64);
      const DIGEST_D = "sha256:" + "d".repeat(64);
      state.pgBuilds.insert({ id: "p16-old", major: 16, minor: 3, source: "downloaded", releaseTag: "old",
        imageDigest: DIGEST_C, path: join(builds, "v16", "old"), status: "ready" });
      state.pgBuilds.insert({ id: "p16-new", major: 16, minor: 9, source: "downloaded", releaseTag: "new",
        imageDigest: DIGEST_D, path: join(builds, "v16", "new"), status: "ready" });
      state.pgBuilds.setActiveExclusive("p16-old");
      expect(registry.pgbinFor(16).buildId).toBe("p16-old");

      // A v17 pull that activates, then hits a recomposeDistrib failure (swallowed post-HARD-2).
      recomposeDistrib.mockRejectedValueOnce(new Error("recomposeDistrib: symlink farm rebuild failed"));
      const { buildId } = await provisioner.pull({ major: 17 });
      await vi.waitFor(() => {
        const job = state.raw.prepare("SELECT status FROM jobs WHERE kind = 'pg_build_pull'").get() as { status: string };
        expect(job.status).not.toBe("running");
      });

      // 17 keeps the new build — no fail, no revert…
      expect(state.pgBuilds.byId(buildId)).toMatchObject({ status: "ready", active: true });
      expect(registry.pgbinFor(17).buildId).toBe(buildId);
      expect(state.pgBuilds.byId("baked-v17")?.active).toBe(false);
      // …and no pointer recovery ran at all, so major 16's operator pin was never in play.
      expect(registry.pgbinFor(16).buildId).toBe("p16-old");
      expect(state.pgBuilds.byId("p16-new")?.active).toBe(false);
    });

    it("swallowed recompose failure racing a laned remove of another build — the lane stays live, the new build stays active, the major never stranded", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      await fakeInstallDir(install, "v17"); // baked v17 (minor 5)
      const { oci } = fakeOci(); // the pull resolves DIGEST_A → finalDir v17/SHORT_A
      // Pulled build is 17.7 — distinct from BOTH the baked 17.5 and the seeded d1 17.6 below —
      // so it activates rather than dedup-no-op'ing before this scenario runs.
      const { state, registry, provisioner, recomposeDistrib } = makeProvisioner({
        install, builds, oci, detectVersion: pathAwareDetectVersion(builds),
      });
      await registry.seedBaked();
      registry.resolveActives(); // baked-v17 active

      // d1: a ready, non-active downloaded build — removable, and exactly the row the OLD
      // destructive path's recovery would have elected (minor 6 > baked 5) before the concurrent
      // remove deleted it out from under the pointer (the pre-fix strand this test used to pin).
      const d1Dir = await fakeVolumeBuild(builds, 17, "d1",
        { digest: DIGEST_B, tag: "d1", major: 17, minor: 6, extractedAt: "x" });
      state.pgBuilds.insert({ id: "d1", major: 17, minor: 6, source: "downloaded", releaseTag: "d1",
        imageDigest: DIGEST_B, path: d1Dir, status: "ready" });

      // Hold the pull's auto-activate open inside recomposeDistrib so the concurrent remove can
      // chain behind the in-flight mutation before the (swallowed) failure fires.
      let rejectRecompose!: (e: Error) => void;
      recomposeDistrib.mockImplementationOnce(() => new Promise((_res, rej) => { rejectRecompose = rej; }));

      const { buildId } = await provisioner.pull({ major: 17 });
      await vi.waitFor(() => expect(recomposeDistrib).toHaveBeenCalled()); // auto-activate suspended; pointer already flipped

      const removePromise = provisioner.remove("d1", () => []); // chains behind the in-flight mutation
      rejectRecompose(new Error("recomposeDistrib: symlink farm rebuild failed"));

      await removePromise; // the lane advanced PAST the swallowed failure and ran the remove

      expect(state.pgBuilds.byId("d1")).toBeNull();
      await expect(access(d1Dir)).rejects.toThrow(); // d1's dir reclaimed as usual
      expect(state.pgBuilds.byId(buildId)).toMatchObject({ status: "ready", active: true, error: null });
      expect(registry.pgbinFor(17).buildId).toBe(buildId); // never stranded, never reverted
    });

    it("explicit activate queued behind a swallowed recompose failure lands cleanly — the pick wins, nothing is failed", async () => {
      const { root, install, builds } = await scaffoldBuildDirs();
      dirs.push(root);
      await fakeInstallDir(install, "v17"); // baked v17 (minor 5)
      const { oci } = fakeOci();
      // Pulled build is 17.7 — distinct from BOTH the baked 17.5 and the seeded d1 17.4 below —
      // so its auto-activate runs (not a dedup no-op) and can be suspended mid-recompose.
      const { state, registry, provisioner, recomposeDistrib } = makeProvisioner({
        install, builds, oci, detectVersion: pathAwareDetectVersion(builds),
      });
      await registry.seedBaked();
      registry.resolveActives(); // baked-v17 active

      // d1: ready but NON-newest (minor 4 < baked 5) — an operator's deliberate pick, issued
      // while the pull's auto-activate is suspended. lastRunMinor was never recorded, so the
      // explicit activate is not a downgrade-409. (Pre-HARD-2 this pinned the recovery GUARD
      // leaving the pick intact; now there is no recovery to guard against — the pick must
      // simply serialize behind the swallowed failure and win.)
      const d1Dir = await fakeVolumeBuild(builds, 17, "d1",
        { digest: DIGEST_B, tag: "d1", major: 17, minor: 4, extractedAt: "x" });
      state.pgBuilds.insert({ id: "d1", major: 17, minor: 4, source: "downloaded", releaseTag: "d1",
        imageDigest: DIGEST_B, path: d1Dir, status: "ready" });

      let rejectRecompose!: (e: Error) => void;
      recomposeDistrib.mockImplementationOnce(() => new Promise((_res, rej) => { rejectRecompose = rej; }));

      const { buildId } = await provisioner.pull({ major: 17 });
      await vi.waitFor(() => expect(recomposeDistrib).toHaveBeenCalled()); // auto-activate suspended

      const activatePromise = provisioner.activate("d1"); // chains behind the in-flight mutation
      rejectRecompose(new Error("recomposeDistrib: symlink farm rebuild failed"));
      await activatePromise; // the lane advanced past the swallowed failure; the pick committed

      // The explicit pick is the final pointer; the pull's build survives as ready-but-inactive
      // (d1's setActiveExclusive cleared it) — nothing was failed, rm'd, or re-resolved.
      expect(registry.pgbinFor(17).buildId).toBe("d1");
      expect(state.pgBuilds.byId(buildId)).toMatchObject({ status: "ready", active: false, error: null });
      expect(state.pgBuilds.byId("baked-v17")?.active).toBe(false);
      await access(join(builds, "v17", SHORT_A, "bin", "postgres")); // the pulled build's dir intact
    });
  });
});
