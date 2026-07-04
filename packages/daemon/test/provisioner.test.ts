import { access, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { BuildRegistry } from "../src/compute/builds/registry.js";
import { Provisioner } from "../src/compute/builds/provisioner.js";
import { LogsService } from "../src/services/logs.js";
import { EventsService } from "../src/services/events.js";
import type { OciPuller } from "../src/compute/builds/oci.js";
import type { DevdbEvent } from "@devdb/shared";
import { cleanupDirs, fakeInstallDir, noopLogger, scaffoldBuildDirs, trackedDirs } from "./helpers/build-fixtures.js";

const dirs = trackedDirs();
afterEach(async () => { await cleanupDirs(dirs); });

const DIGEST_A = "sha256:" + "a".repeat(64);
const DIGEST_B = "sha256:" + "b".repeat(64);

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
});
