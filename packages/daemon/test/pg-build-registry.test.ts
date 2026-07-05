import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openState } from "../src/state/db.js";
import { BuildRegistry } from "../src/compute/builds/registry.js";
import { DevdbError } from "../src/services/errors.js";
import { buildByMajorAndTag, cleanupDirs, fakeInstallDir, fakeVolumeBuild, fakeVolumeBuildNamed, noopLogger, scaffoldBuildDirs, trackedDirs } from "./helpers/build-fixtures.js";

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
      // Mirror real detectPostgresVersion (version.ts: execFile(pgbin, ["--version"])) on the one
      // dimension these tests need: a pgbin whose FILE no longer exists must throw, exactly like a
      // real execFile ENOENT would — a boot-robustness FIX-2 caller (adoptVolumeBuilds' presence
      // sweep) now calls detectVersion where a bare access() presence probe used to run, and
      // several existing "dir vanished" tests rely on that failure mode reaching this fake.
      if (!existsSync(pgbin)) throw new Error(`ENOENT (fake): ${pgbin}`);
      // Real detectPostgresVersion execs the EXACT pgbin path (version.ts) — a call on anything but
      // <dir>/bin/postgres would ENOENT/EACCES. Match the exact binary path (not a loose prefix) so
      // a caller that accidentally passes row.path (the dir) instead of join(row.path,"bin","postgres")
      // is caught here (no fake version) rather than silently "detecting" a version for a non-binary.
      const hit = Object.entries(a.versions).find(([prefix]) => pgbin === join(prefix, "bin", "postgres"));
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
    expect(() => registry.assertRemovable(buildByMajorAndTag(state,16, "t3")!.id, [])).toThrow(/active/);
    expect(() => registry.assertRemovable("baked-v16", [])).toThrow(/baked/);
    expect(() => registry.assertRemovable(
      buildByMajorAndTag(state,16, "t2")!.id,
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
    const row = buildByMajorAndTag(state,16, "t1")!;
    expect(row.status).toBe("ready");

    await rm(join(dl, "bin", "postgres"), { force: true }); // dir + build.json survive; only the binary vanishes

    await registry.adoptVolumeBuilds();

    expect(state.pgBuilds.byId(row.id)!.status).toBe("failed");
  });

  // Boot-robustness FIX 2: the trailing presence sweep for previously-adopted rows used to only
  // access()-probe bin/postgres — it never re-detected the VERSION, so an in-place binary swap
  // (same dir + marker, different binary version) kept the row's STALE recorded minor, which could
  // dodge the never-silent-downgrade guard. The sweep must RE-DETECT and reject on drift, mirroring
  // the unclaimed-adoption path's reject-on-mismatch (registry.ts:141).
  it("re-scan fails an already-claimed ready row whose binary was swapped in place (version drift)", async () => {
    const { install, builds } = await scaffold();
    const dl = await fakeVolumeBuild(builds, 16, "t1", { digest: "sha256:3", tag: "t1", major: 16, minor: 10, extractedAt: "x" });
    const versions: Record<string, { major: number; minor: number }> = { [dl]: { major: 16, minor: 10 } };
    const { state, registry } = makeRegistry({ install, builds, versions });
    await registry.adoptVolumeBuilds();
    const row = buildByMajorAndTag(state, 16, "t1")!;
    expect(row).toMatchObject({ status: "ready", minor: 10 });

    // Simulate an in-place binary swap: same dir + marker, but the binary now detects a DIFFERENT
    // version (dir untouched on disk — only the fake detectVersion's view of it changes).
    versions[dl] = { major: 16, minor: 99 };

    await registry.adoptVolumeBuilds(); // re-scan, as a fresh boot would

    const after = state.pgBuilds.byId(row.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/drift/);
    expect(after.error).toMatch(/detected 16\.99/);
    expect(after.error).toMatch(/recorded 16\.10/);
  });

  it("re-scan control: matching version on re-scan leaves an already-claimed ready row alone", async () => {
    const { install, builds } = await scaffold();
    const dl = await fakeVolumeBuild(builds, 16, "t1", { digest: "sha256:4", tag: "t1", major: 16, minor: 10, extractedAt: "x" });
    const versions: Record<string, { major: number; minor: number }> = { [dl]: { major: 16, minor: 10 } };
    const { state, registry } = makeRegistry({ install, builds, versions });
    await registry.adoptVolumeBuilds();
    const row = buildByMajorAndTag(state, 16, "t1")!;
    expect(row.status).toBe("ready");

    await registry.adoptVolumeBuilds(); // re-scan with no change to the binary

    expect(state.pgBuilds.byId(row.id)).toMatchObject({ status: "ready", minor: 10 });
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

  // FIX-6: adoptVolumeBuilds validates a marker's shape + on-disk consistency (dir==shortDigest,
  // major==vN) and adopts the DETECTED binary version, rejecting any disagreement — a marker is
  // never trusted to name the version (previously a raw cast let a forged marker surface a
  // wrong-version ready+active build that dodged the downgrade guard).
  it("adopts a consistent marker at the DETECTED version; id = dl-{major}-{digest16}", async () => {
    const { install, builds } = await scaffold();
    const digest = "sha256:" + "c".repeat(64);
    // marker CLAIMS minor 5; the binary detects 6 — the DETECTED version is adopted, not the marker's.
    const dir = await fakeVolumeBuild(builds, 17, "latest", { digest, tag: "latest", major: 17, minor: 5, extractedAt: "x" });
    const { state, registry } = makeRegistry({ install, builds, versions: { [dir]: { major: 17, minor: 6 } } });
    await registry.adoptVolumeBuilds();

    const row = state.pgBuilds.byId(`dl-17-${"c".repeat(16)}`);
    expect(row).toMatchObject({
      major: 17, minor: 6, source: "downloaded", releaseTag: "latest",
      imageDigest: digest, path: dir, status: "ready",
    });
    expect(state.pgBuilds.list()).toHaveLength(1);
  });

  it("REJECTS a marker whose dir basename != shortDigest(digest) (renamed/tampered install)", async () => {
    const { install, builds } = await scaffold();
    const digest = "sha256:" + "c".repeat(64);
    const dir = await fakeVolumeBuildNamed(builds, 17, "renamed-by-hand", { digest, tag: "latest", major: 17, minor: 5, extractedAt: "x" });
    const { state, registry } = makeRegistry({ install, builds, versions: { [dir]: { major: 17, minor: 5 } } });
    await registry.adoptVolumeBuilds();
    expect(state.pgBuilds.list()).toHaveLength(0);
  });

  it("REJECTS a marker whose major disagrees with the vN dir", async () => {
    const { install, builds } = await scaffold();
    const digest = "sha256:" + "e".repeat(64);
    const dir = await fakeVolumeBuild(builds, 17, "latest", { digest, tag: "latest", major: 16, minor: 5, extractedAt: "x" }); // major 16 under v17
    const { state, registry } = makeRegistry({ install, builds, versions: { [dir]: { major: 16, minor: 5 } } });
    await registry.adoptVolumeBuilds();
    expect(state.pgBuilds.list()).toHaveLength(0);
  });

  it("REJECTS a build whose binary major disagrees with a consistent marker (forged 17.99)", async () => {
    const { install, builds } = await scaffold();
    const digest = "sha256:" + "f".repeat(64);
    const dir = await fakeVolumeBuild(builds, 17, "latest", { digest, tag: "latest", major: 17, minor: 99, extractedAt: "x" });
    // dir + marker are self-consistent (v17, digest matches), but the BINARY really detects major 16.
    const { state, registry } = makeRegistry({ install, builds, versions: { [dir]: { major: 16, minor: 5 } } });
    await registry.adoptVolumeBuilds();
    expect(state.pgBuilds.list()).toHaveLength(0);
    expect(state.pgBuilds.list().some((r) => r.minor === 99)).toBe(false); // the forged 17.99 never surfaces
  });

  it("REJECTS a shape-invalid marker (missing major) instead of inserting an undefined-major row", async () => {
    const { install, builds } = await scaffold();
    const digest = "sha256:" + "a".repeat(64);
    // digest is valid and matches the dir, but `major` is missing — a raw cast would insert major=undefined.
    const dir = await fakeVolumeBuildNamed(builds, 17, "a".repeat(16), { digest, tag: "latest", minor: 5, extractedAt: "x" });
    const { state, registry } = makeRegistry({ install, builds, versions: { [dir]: { major: 17, minor: 5 } } });
    await registry.adoptVolumeBuilds();
    expect(state.pgBuilds.list()).toHaveLength(0);
  });

  it("seedBaked skips a mislabeled baked dir whose binary major != the vN dir name", async () => {
    const { install, builds } = await scaffold();
    const v17 = await fakeInstallDir(install, "v17");
    // The v17 dir's binary really reports major 16 (a packaging error) — must NOT seed a baked-v17 row.
    const { state, registry } = makeRegistry({ install, builds, versions: { [v17]: { major: 16, minor: 3 } } });
    await registry.seedBaked();
    expect(state.pgBuilds.byId("baked-v17")).toBeNull();
    expect(state.pgBuilds.list()).toHaveLength(0);
  });

  it("adoptVolumeBuilds skips a dir already claimed by an existing (pull-created, UUID-id) row — no duplicate rows across boots", async () => {
    const { install, builds } = await scaffold();
    const digest = "sha256:" + "d".repeat(64);
    const dir = await fakeVolumeBuild(builds, 17, "d".repeat(16),
      { digest, tag: "latest", major: 17, minor: 5, extractedAt: "x" });
    // Boot-robustness FIX 2: the trailing presence sweep now re-detects this row's version too
    // (it's source:"downloaded", status:"ready") — supply a matching entry so the sweep sees the
    // same 17.5 the row already records, same as a real binary reporting its expected version.
    const { state, registry } = makeRegistry({ install, builds, versions: { [dir]: { major: 17, minor: 5 } } });
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

  // FIX-1 (final whole-branch review): resolveActiveFor — the post-pull-failure recovery primitive
  // — used to set/clear only the ACTIVE pointer, never the degraded flag. When recovery elects a
  // build BELOW the major's recorded high-water (last-run) minor, the major silently runs
  // downgraded until the next boot's resolveActives() — violating the never-silent-downgrade
  // invariant on the one path (of boot / explicit-activate / recovery) that neither flags nor
  // blocks. It must replicate resolveActives' high-water check for its single major.
  it("resolveActiveFor flags the major degraded when it elects a build below the last-run high-water", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const { state, registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 } } });
    await registry.seedBaked();
    state.pgMajors.recordRun(16, 99); // high-water far above the only ready build

    registry.resolveActiveFor(16); // recovery elects baked 16.9 < 99

    expect(registry.pgbinFor(16).version).toBe("16.9"); // pointer restored, as before…
    expect(registry.degradedMajors()).toEqual([16]);    // …but no longer silently
  });

  it("resolveActiveFor clears a stale degraded flag when it elects at/above the high-water", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const { state, registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 } } });
    await registry.seedBaked();
    state.pgMajors.recordRun(16, 99);
    registry.resolveActives(); // 16.9 < 99 → degraded
    expect(registry.degradedMajors()).toEqual([16]);

    state.pgMajors.setLastRunMinor(16, 9); // consented rollback lowered the high-water
    registry.resolveActiveFor(16);         // now elects 16.9 >= 9

    expect(registry.degradedMajors()).toEqual([]);
  });

  it("resolveActiveFor with no ready candidate clears the active pointer AND the degraded flag", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const { state, registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 } } });
    await registry.seedBaked();
    state.pgMajors.recordRun(16, 99);
    registry.resolveActives(); // degraded [16], baked-v16 active
    expect(registry.degradedMajors()).toEqual([16]);

    state.pgBuilds.setStatus("baked-v16", "failed", "gone"); // no ready rows left for 16
    registry.resolveActiveFor(16);

    expect(() => registry.pgbinFor(16)).toThrow(/no usable/);
    expect(state.pgBuilds.byId("baked-v16")?.active).toBe(false);
    expect(registry.degradedMajors()).toEqual([]); // no active build ⇒ not "degraded"
  });

  // FIX-2 (final whole-branch review): seedBaked used to skip any existing baked-v{major} row on
  // the premise "a baked minor cannot change without a new image" — but a new image on the
  // PERSISTED VOLUME is the supported upgrade path. A stale row minor makes recordRun record the
  // wrong high-water and lets a later explicit activate of an equal-minor downloaded build pass
  // the downgrade guard while really downgrading past the on-disk catalog.
  it("seedBaked re-probes an existing baked row and updates its minor after an image upgrade", async () => {
    const { install, builds } = await scaffold();
    const v17 = await fakeInstallDir(install, "v17");
    const versions: Record<string, { major: number; minor: number }> = { [v17]: { major: 17, minor: 5 } };
    const { state, registry } = makeRegistry({ install, builds, versions });
    await registry.seedBaked();
    expect(state.pgBuilds.byId("baked-v17")).toMatchObject({ minor: 5, status: "ready" });

    versions[v17] = { major: 17, minor: 6 }; // image upgraded: same dir, binary is now 17.6
    await registry.seedBaked();              // next boot

    expect(state.pgBuilds.byId("baked-v17")).toMatchObject({ minor: 6, status: "ready" });
  });

  it("seedBaked fails a baked row whose install dir vanished (image dropped the major) and resurrects it if the dir returns", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const v17 = await fakeInstallDir(install, "v17");
    const { state, registry } = makeRegistry({
      install, builds,
      versions: { [v16]: { major: 16, minor: 9 }, [v17]: { major: 17, minor: 5 } },
    });
    await registry.seedBaked();
    registry.resolveActives();
    expect(state.pgBuilds.byId("baked-v17")).toMatchObject({ status: "ready", active: true });

    await rm(v17, { recursive: true, force: true }); // new image no longer ships v17
    await registry.seedBaked();                      // next boot

    expect(state.pgBuilds.byId("baked-v17")?.status).toBe("failed"); // not a zombie ready row with a dangling path
    registry.resolveActives();
    expect(() => registry.pgbinFor(17)).toThrow(/no usable/);
    expect(state.pgBuilds.byId("baked-v17")?.active).toBe(false);
    expect(registry.pgbinFor(16).version).toBe("16.9"); // other majors unaffected

    await fakeInstallDir(install, "v17"); // a later image re-adds the major
    await registry.seedBaked();
    expect(state.pgBuilds.byId("baked-v17")).toMatchObject({ status: "ready", minor: 5 });
  });

  // FIX-4 (final whole-branch review): rows that fail BEFORE setDigestPath keep path === "" — and
  // FIX-3 now clears the path on every failure-rm, making empty-path a normal post-failure state.
  // The in-use guard's prefix test (`pgbin.startsWith(row.path + "/")`) degenerates to
  // startsWith("/") for such rows, matching EVERY running pgbin — so any running endpoint made
  // every early-failed row un-deletable with a misleading "in use" 409.
  it("assertRemovable: an empty-path failed row is never 'in use', even while endpoints run", async () => {
    const { install, builds } = await scaffold();
    const { state, registry } = makeRegistry({ install, builds, versions: {} });
    state.pgBuilds.insert({
      id: "early-fail", major: 17, source: "downloaded", releaseTag: "latest",
      imageDigest: "", path: "", status: "failed",
    });

    const row = registry.assertRemovable("early-fail", ["/data/pg_builds/v17/abc/bin/postgres"]);

    expect(row.id).toBe("early-fail"); // no 409 "in use by a running endpoint"
  });

  // FIX-5 (final whole-branch review): a crash/restart mid-pull leaves a row in downloading/
  // validating forever — boot never transitioned it, and assertRemovable's in-flight guard made
  // it un-removable (stuck until the user wipes state.db). No pull survives a restart, so at boot
  // any such row is definitionally orphaned: fail it so it becomes terminal + deletable.
  it("failInterrupted (boot) fails orphaned in-flight rows so they become terminal and deletable", async () => {
    const { install, builds } = await scaffold();
    const { state, registry } = makeRegistry({ install, builds, versions: {} });
    state.pgBuilds.insert({
      id: "orphan-dl", major: 17, source: "downloaded", releaseTag: "latest",
      imageDigest: "", path: "", status: "downloading",
    });
    state.pgBuilds.insert({
      id: "orphan-val", major: 17, source: "downloaded", releaseTag: "latest",
      imageDigest: "sha256:" + "f".repeat(64), path: join(builds, "v17", "f".repeat(16)), status: "validating",
    });
    state.pgBuilds.insert({
      id: "fine", major: 16, source: "downloaded", releaseTag: "t",
      imageDigest: "sha256:" + "9".repeat(64), path: join(builds, "v16", "9".repeat(16)), status: "ready",
    });

    const count = await registry.failInterrupted();

    expect(count).toBe(2);
    expect(state.pgBuilds.byId("orphan-dl")).toMatchObject({ status: "failed", error: "interrupted by restart" });
    expect(state.pgBuilds.byId("orphan-val")).toMatchObject({ status: "failed", error: "interrupted by restart" });
    expect(state.pgBuilds.byId("fine")?.status).toBe("ready"); // terminal/ready rows untouched
    // Previously these 409'd "pull in flight" forever; now they are removable.
    expect(registry.assertRemovable("orphan-dl", []).id).toBe("orphan-dl");
    expect(registry.assertRemovable("orphan-val", []).id).toBe("orphan-val");
  });

  // Boot-robustness FIX 1: an interrupted (crash-mid-download/validate) build was never validated
  // — worthless — so its leftover finalDir is safe to reclaim, not just orphan. Previously
  // failInterrupted kept the row's path "so a DELETE can reclaim the dir" — but that leaves the
  // dir SQUATTING on the content-addressed path until the user manually DELETEs the failed row,
  // and a same-digest re-pull's rename(tmp → finalDir) then fails ENOTEMPTY in the meantime.
  it("failInterrupted reclaims the leftover finalDir of an interrupted build (no manual DELETE needed)", async () => {
    const { install, builds } = await scaffold();
    const { state, registry } = makeRegistry({ install, builds, versions: {} });
    const dir = await fakeVolumeBuild(builds, 17, "t1",
      { digest: "sha256:" + "1".repeat(64), tag: "t1", major: 17, minor: 5, extractedAt: "x" });
    state.pgBuilds.insert({
      id: "crashed-validating", major: 17, source: "downloaded", releaseTag: "t1",
      imageDigest: "sha256:" + "1".repeat(64), path: dir, status: "validating",
    });

    const count = await registry.failInterrupted();

    expect(count).toBe(1);
    const row = state.pgBuilds.byId("crashed-validating")!;
    expect(row.status).toBe("failed");
    expect(existsSync(dir)).toBe(false); // dir reclaimed, not left squatting
    expect(row.path).toBe(""); // path cleared — mirrors the post-failure-rm invariant elsewhere
  });

  it("failInterrupted's dir reclaim respects a sibling still claiming the same path", async () => {
    const { install, builds } = await scaffold();
    const { state, registry } = makeRegistry({ install, builds, versions: {} });
    const digest = "sha256:" + "2".repeat(64);
    const dir = await fakeVolumeBuild(builds, 17, "t1", { digest, tag: "t1", major: 17, minor: 5, extractedAt: "x" });
    // Two rows share one path — a gate-failed/crashed attempt sits alongside a ready sibling that
    // still claims the SAME digest-named dir (see state/repos.ts byDigest doc / provisioner FIX-3(b)).
    state.pgBuilds.insert({
      id: "ready-sibling", major: 17, source: "downloaded", releaseTag: "t1",
      imageDigest: digest, path: dir, status: "ready",
    });
    state.pgBuilds.insert({
      id: "crashed-sibling", major: 17, source: "downloaded", releaseTag: "t1",
      imageDigest: digest, path: dir, status: "validating",
    });

    const count = await registry.failInterrupted();

    expect(count).toBe(1);
    expect(state.pgBuilds.byId("crashed-sibling")).toMatchObject({ status: "failed", path: dir }); // path kept: still claimed
    expect(state.pgBuilds.byId("ready-sibling")?.status).toBe("ready"); // untouched
    expect(existsSync(dir)).toBe(true); // ready sibling still claims it — dir survives
  });

  it("failInterrupted reclaims a dir shared by TWO interrupted rows (neither is the other's surviving claimant)", async () => {
    const { install, builds } = await scaffold();
    const { state, registry } = makeRegistry({ install, builds, versions: {} });
    const digest = "sha256:" + "3".repeat(64);
    const dir = await fakeVolumeBuild(builds, 17, "t1", { digest, tag: "t1", major: 17, minor: 5, extractedAt: "x" });
    // Both rows are interrupted — no ready survivor. The old "any other row claims the path" guard
    // would make each preserve the dir for the other (leaving it squatting → ENOTEMPTY persists);
    // only a SURVIVING (non-interrupted) claimant should keep it.
    state.pgBuilds.insert({ id: "crashed-a", major: 17, source: "downloaded", releaseTag: "t1", imageDigest: digest, path: dir, status: "validating" });
    state.pgBuilds.insert({ id: "crashed-b", major: 17, source: "downloaded", releaseTag: "t1", imageDigest: digest, path: dir, status: "downloading" });

    const count = await registry.failInterrupted();

    expect(count).toBe(2);
    expect(state.pgBuilds.byId("crashed-a")).toMatchObject({ status: "failed", path: "" });
    expect(state.pgBuilds.byId("crashed-b")).toMatchObject({ status: "failed", path: "" });
    expect(existsSync(dir)).toBe(false); // no surviving claimant → dir reclaimed
  });

  it("activate() to a non-downgrade build clears the degraded flag without a reboot", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    // Create the downloaded dir up front so its DETECTED version is wired before adoptVolumeBuilds
    // (FIX-6 re-detects on adoption). digest "sha256:2" → dir "2"; binary detects 16.10.
    const dl = await fakeVolumeBuild(builds, 16, "t1", { digest: "sha256:2", tag: "t1", major: 16, minor: 10, extractedAt: "x" });
    const { state, registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 }, [dl]: { major: 16, minor: 10 } } });
    await registry.seedBaked();
    state.pgMajors.recordRun(16, 10); // last-run high-water is AHEAD of the only ready build
    registry.resolveActives(); // resolves to baked 16.9 < lastRunMinor(16)=10 → degraded
    expect(registry.degradedMajors()).toEqual([16]);

    await registry.adoptVolumeBuilds(); // adopts the downloaded 16.10 (detected), ready but not active
    const row = buildByMajorAndTag(state, 16, "t1")!;

    const activated = registry.activate(row.id); // minor 10 >= lastRunMinor 10 — NOT a downgrade, no consent needed
    expect(activated.active).toBe(true);
    expect(registry.degradedMajors()).toEqual([]); // cleared immediately, no reboot required
  });
});
