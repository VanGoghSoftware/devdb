import { access, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { BuildRegistry } from "../src/compute/builds/registry.js";
import { Provisioner } from "../src/compute/builds/provisioner.js";
import { LogsService } from "../src/services/logs.js";
import { EventsService } from "../src/services/events.js";
import { DevdbError } from "../src/services/errors.js";
import type { OciPuller } from "../src/compute/builds/oci.js";
import type { DevdbEvent } from "@devdb/shared";
import { cleanupDirs, fakeInstallDir, fakeVolumeBuild, noopLogger, scaffoldBuildDirs, trackedDirs } from "./helpers/build-fixtures.js";

const dirs = trackedDirs();
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
  validate?: (v: { major: number; buildPath: string }) => Promise<void>;
  detectVersion?: (pgbin: string) => Promise<{ major: number; minor: number }>;
  statfsFree?: (dir: string) => Promise<number>;
  du?: (dir: string) => Promise<number | null>;
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
    cfg: { pgBuildsDir: a.builds, pgImageTemplate: "neondatabase/compute-node-v{major}" },
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
});
