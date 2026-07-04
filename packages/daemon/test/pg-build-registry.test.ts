import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openState } from "../src/state/db.js";
import { BuildRegistry } from "../src/compute/builds/registry.js";
import { DevdbError } from "../src/services/errors.js";
import { cleanupDirs, fakeInstallDir, fakeVolumeBuild, noopLogger, scaffoldBuildDirs, trackedDirs } from "./helpers/build-fixtures.js";

const dirs = trackedDirs();
// Thin local adapter over the shared scaffoldBuildDirs(): this file's call sites only ever
// destructure `{ install, builds }` and rely on `root` being auto-tracked for afterEach cleanup —
// preserved here so every existing call site (`const { install, builds } = await scaffold()`)
// needs no change.
async function scaffold(): Promise<{ install: string; builds: string }> {
  const { root, install, builds } = await scaffoldBuildDirs();
  dirs.push(root);
  return { install, builds };
}
function makeRegistry(a: { install: string; builds: string; versions: Record<string, { major: number; minor: number }> }) {
  const state = openState(":memory:");
  const registry = new BuildRegistry({
    state, pgInstallDir: a.install, pgBuildsDir: a.builds, logger: noopLogger,
    detectVersion: async (pgbin) => {
      const hit = Object.entries(a.versions).find(([prefix]) => pgbin.startsWith(prefix));
      if (!hit) throw new Error(`no fake version for ${pgbin}`);
      return hit[1];
    },
  });
  return { state, registry };
}
afterEach(async () => { await cleanupDirs(dirs); });

describe("BuildRegistry", () => {
  it("seedBaked scans v* dirs, skips vanilla_*, and resolveActives picks baked when alone", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    await fakeInstallDir(install, "vanilla_v17");
    const { registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 } } });
    await registry.seedBaked();
    expect(registry.installedMajors()).toEqual([16]);
    const { degraded } = registry.resolveActives();
    expect(degraded).toEqual([]);
    expect(registry.pgbinFor(16)).toMatchObject({ path: join(v16, "bin", "postgres"), version: "16.9" });
  });

  it("newest valid minor wins regardless of source; tie goes to baked", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const newer = await fakeVolumeBuild(builds, 16, "9124", { digest: "sha256:a", tag: "9124", major: 16, minor: 10, extractedAt: "x" });
    const same = await fakeVolumeBuild(builds, 16, "8464", { digest: "sha256:b", tag: "8464", major: 16, minor: 9, extractedAt: "x" });
    const { registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 }, [newer]: { major: 16, minor: 10 }, [same]: { major: 16, minor: 9 } } });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    registry.resolveActives();
    expect(registry.pgbinFor(16).version).toBe("16.10"); // downloaded newer wins
    // NOTE: this does not exercise the tie-break (16.10 beats both 16.9 rows outright on minor).
    // The baked-wins-a-genuine-tie case is covered separately below.
    expect(registry.versionForPgbin(registry.pgbinFor(16).path)).toBe("16.10");
  });

  it("volume build with vanished dir is failed at adopt; resolution falls back and flags downgrade vs lastRunMinor", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const gone = await fakeVolumeBuild(builds, 16, "9124", { digest: "sha256:a", tag: "9124", major: 16, minor: 10, extractedAt: "x" });
    const { state, registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 }, [gone]: { major: 16, minor: 10 } } });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    registry.resolveActives();
    state.pgMajors.recordRun(16, 10);              // 16.10 has RUN
    await rm(gone, { recursive: true, force: true }); // volume build lost
    await registry.adoptVolumeBuilds();             // re-scan (as a fresh boot would)
    const { degraded } = registry.resolveActives();
    expect(degraded).toEqual([16]);                 // silent downgrade forbidden — flagged
    expect(registry.pgbinFor(16).version).toBe("16.9");
    expect(registry.degradedMajors()).toEqual([16]);
  });

  it("activate: ready-only, exclusive, downgrade needs consent (which lowers the high-water + clears flag)", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const dl = await fakeVolumeBuild(builds, 16, "9124", { digest: "sha256:a", tag: "9124", major: 16, minor: 10, extractedAt: "x" });
    const { state, registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 }, [dl]: { major: 16, minor: 10 } } });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    registry.resolveActives();
    state.pgMajors.recordRun(16, 10);
    const baked = state.pgBuilds.byId("baked-v16")!;
    expect(() => registry.activate(baked.id)).toThrow(/downgrade/);
    const after = registry.activate(baked.id, { consented: true });
    expect(after.active).toBe(true);
    expect(state.pgMajors.lastRunMinor(16)).toBe(9);
    expect(registry.degradedMajors()).toEqual([]);
  });

  it("assertRemovable rejects active, baked, and in-use rows; gcCandidates keeps active + newest previous", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const b1 = await fakeVolumeBuild(builds, 16, "t1", { digest: "sha256:1", tag: "t1", major: 16, minor: 10, extractedAt: "x" });
    const b2 = await fakeVolumeBuild(builds, 16, "t2", { digest: "sha256:2", tag: "t2", major: 16, minor: 11, extractedAt: "x" });
    const b3 = await fakeVolumeBuild(builds, 16, "t3", { digest: "sha256:3", tag: "t3", major: 16, minor: 12, extractedAt: "x" });
    const { state, registry } = makeRegistry({
      install, builds,
      versions: { [v16]: { major: 16, minor: 9 }, [b1]: { major: 16, minor: 10 }, [b2]: { major: 16, minor: 11 }, [b3]: { major: 16, minor: 12 } },
    });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    registry.resolveActives(); // active = 16.12 (t3)
    expect(() => registry.assertRemovable(state.pgBuilds.byMajorAndTag(16, "t3")!.id, [])).toThrow(/active/);
    expect(() => registry.assertRemovable("baked-v16", [])).toThrow(/baked/);
    expect(() => registry.assertRemovable(
      state.pgBuilds.byMajorAndTag(16, "t2")!.id,
      [join(b2, "bin", "postgres")],
    )).toThrow(/running endpoint/);
    // keep active (t3) + newest previous (t2) → only t1 is GC-eligible
    expect(registry.gcCandidates().map((r) => r.releaseTag)).toEqual(["t1"]);
  });

  it("resolveActives clears active for a major whose only rows are non-ready (no ready candidates)", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const v17 = await fakeInstallDir(install, "v17");
    const v18 = await fakeVolumeBuild(builds, 18, "t1", { digest: "sha256:1", tag: "t1", major: 18, minor: 3, extractedAt: "x" });
    const { registry } = makeRegistry({
      install, builds,
      versions: { [v16]: { major: 16, minor: 9 }, [v17]: { major: 17, minor: 4 }, [v18]: { major: 18, minor: 3 } },
    });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    registry.resolveActives(); // v18 downloaded-only build is active+ready here
    const v18RowId = registry.pgbinFor(18).buildId;

    await rm(v18, { recursive: true, force: true }); // the only v18 build vanishes
    await registry.adoptVolumeBuilds(); // marks the v18 row failed (dir gone)
    registry.resolveActives(); // v16/v17 still resolve fine; v18 has ZERO ready rows

    expect(() => registry.pgbinFor(18)).toThrow(/no usable/);
    // Stale active=1 from before must be cleared — assertRemovable must NOT see it as active.
    expect(registry.assertRemovable(v18RowId, [])).toMatchObject({ id: v18RowId });
    // Unaffected majors keep resolving normally.
    expect(registry.pgbinFor(16).version).toBe("16.9");
    expect(registry.pgbinFor(17).version).toBe("17.4");
  });

  it("stale sweep fails a downloaded ready row whose bin/postgres vanished but dir + build.json survive", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const dl = await fakeVolumeBuild(builds, 16, "t1", { digest: "sha256:1", tag: "t1", major: 16, minor: 10, extractedAt: "x" });
    const { state, registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 }, [dl]: { major: 16, minor: 10 } } });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    const row = state.pgBuilds.byMajorAndTag(16, "t1")!;
    expect(row.status).toBe("ready");

    await rm(join(dl, "bin", "postgres"), { force: true }); // dir + build.json survive; only the binary vanishes

    await registry.adoptVolumeBuilds();

    expect(state.pgBuilds.byId(row.id)!.status).toBe("failed");
  });

  it("baked wins a genuine tie at EQUAL minor against a downloaded build for the same major", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const dl = await fakeVolumeBuild(builds, 16, "t1", { digest: "sha256:1", tag: "t1", major: 16, minor: 9, extractedAt: "x" });
    const { registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 }, [dl]: { major: 16, minor: 9 } } });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    registry.resolveActives();

    expect(registry.pgbinFor(16).buildId).toBe("baked-v16"); // baked wins the tie
  });

  it("adoptVolumeBuilds derives the row id from the marker's digest (dl-{major}-{digest16}) — the dir name is not identity", async () => {
    const { install, builds } = await scaffold();
    const digest = "sha256:" + "c".repeat(64);
    // Deliberately NOT digest-named: identity must come from the marker, not the dir basename.
    const dir = await fakeVolumeBuild(builds, 17, "renamed-by-hand",
      { digest, tag: "latest", major: 17, minor: 5, extractedAt: "x" });
    const { state, registry } = makeRegistry({ install, builds, versions: {} });
    await registry.adoptVolumeBuilds();

    const row = state.pgBuilds.byId(`dl-17-${"c".repeat(16)}`);
    expect(row).toMatchObject({
      major: 17, minor: 5, source: "downloaded", releaseTag: "latest",
      imageDigest: digest, path: dir, status: "ready",
    });
    expect(state.pgBuilds.list()).toHaveLength(1); // and nothing keyed off the dir name
  });

  it("adoptVolumeBuilds skips a dir already claimed by an existing (pull-created, UUID-id) row — no duplicate rows across boots", async () => {
    const { install, builds } = await scaffold();
    const digest = "sha256:" + "d".repeat(64);
    const dir = await fakeVolumeBuild(builds, 17, "d".repeat(16),
      { digest, tag: "latest", major: 17, minor: 5, extractedAt: "x" });
    const { state, registry } = makeRegistry({ install, builds, versions: {} });
    // A pull-created row keeps its UUID id (never the dl- form) but owns the same dir.
    state.pgBuilds.insert({
      id: "3b9a4c1e-uuid-of-the-pull", major: 17, minor: 5, source: "downloaded",
      releaseTag: "latest", imageDigest: digest, path: dir, status: "ready",
    });

    await registry.adoptVolumeBuilds();

    // Without the path claim check this would insert a dl-17-… duplicate sharing the same dir —
    // whose later removal/GC would rm the live build's directory out from under the real row.
    expect(state.pgBuilds.list()).toHaveLength(1);
    expect(state.pgBuilds.byId("3b9a4c1e-uuid-of-the-pull")?.status).toBe("ready");
  });

  it("assertRemovable rejects a row whose pull is in flight (downloading/validating)", async () => {
    const { install, builds } = await scaffold();
    const { state, registry } = makeRegistry({ install, builds, versions: {} });
    state.pgBuilds.insert({
      id: "dl-a", major: 17, source: "downloaded", releaseTag: "latest",
      imageDigest: "", path: "", status: "downloading",
    });
    state.pgBuilds.insert({
      id: "dl-b", major: 17, source: "downloaded", releaseTag: "latest",
      imageDigest: "sha256:" + "e".repeat(64), path: join(builds, "v17", "e".repeat(16)), status: "validating",
    });
    expect(() => registry.assertRemovable("dl-a", [])).toThrow(/in flight/);
    expect(() => registry.assertRemovable("dl-b", [])).toThrow(/in flight/);
  });

  // Fix round 1 (review of Task 10 commit 3bfc859, Fix #3, P4): the contract says an unknown :id
  // returns 404 — activate()/assertRemovable() previously folded a missing row into their own
  // 409 (respectively "not ready to activate" / "not found"), indistinguishable from the real
  // removability/activation CONFLICT 409s (a row that exists but isn't ready/isn't removable
  // right now). statusOf() below throws-and-captures once so every case can assert on the
  // DevdbError's statusCode specifically, not just its message.
  function statusOf(fn: () => unknown): number {
    try {
      fn();
      expect.unreachable("must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DevdbError);
      return (e as DevdbError).statusCode;
    }
  }

  it("activate() on an unknown id throws 404, distinct from the 409 not-ready case", async () => {
    const { install, builds } = await scaffold();
    const { registry } = makeRegistry({ install, builds, versions: {} });

    expect(statusOf(() => registry.activate("no-such-build"))).toBe(404);
  });

  it("activate() on an existing but not-ready row still throws 409 (unchanged)", async () => {
    const { install, builds } = await scaffold();
    const { state, registry } = makeRegistry({ install, builds, versions: {} });
    state.pgBuilds.insert({
      id: "still-downloading", major: 17, source: "downloaded", releaseTag: "latest",
      imageDigest: "", path: "", status: "downloading",
    });

    expect(statusOf(() => registry.activate("still-downloading"))).toBe(409);
  });

  // Fix round 1 (Fix #3, P4): same distinction for assertRemovable — a missing row must 404, not
  // fold into the generic 409 "not found" it previously used for exactly this case.
  it("assertRemovable() on an unknown id throws 404, distinct from the 409 removability-conflict cases", async () => {
    const { install, builds } = await scaffold();
    const { registry } = makeRegistry({ install, builds, versions: {} });

    expect(statusOf(() => registry.assertRemovable("no-such-build", []))).toBe(404);
  });

  it("activate() to a non-downgrade build clears the degraded flag without a reboot", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const { state, registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 } } });
    await registry.seedBaked();
    state.pgMajors.recordRun(16, 10); // last-run high-water is AHEAD of the only ready build
    registry.resolveActives(); // resolves to baked 16.9 < lastRunMinor(16)=10 → degraded
    expect(registry.degradedMajors()).toEqual([16]);

    const dl = await fakeVolumeBuild(builds, 16, "t1", { digest: "sha256:2", tag: "t1", major: 16, minor: 10, extractedAt: "x" });
    await registry.adoptVolumeBuilds();
    const row = state.pgBuilds.byMajorAndTag(16, "t1")!;
    state.pgBuilds.setStatus(row.id, "ready"); // pretend the pull-and-extract just completed
    void dl;

    const activated = registry.activate(row.id); // minor 10 >= lastRunMinor 10 — NOT a downgrade, no consent needed
    expect(activated.active).toBe(true);
    expect(registry.degradedMajors()).toEqual([]); // cleared immediately, no reboot required
  });
});
