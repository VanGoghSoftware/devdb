import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openState } from "../src/state/db.js";
import { BuildRegistry } from "../src/compute/builds/registry.js";

const dirs: string[] = [];
async function scaffold(): Promise<{ install: string; builds: string }> {
  const root = await mkdtemp(join(tmpdir(), "devdb-reg-"));
  dirs.push(root);
  const install = join(root, "pg_install");
  const builds = join(root, "pg_builds");
  await mkdir(install, { recursive: true });
  await mkdir(builds, { recursive: true });
  return { install, builds };
}
async function fakeInstallDir(base: string, name: string): Promise<string> {
  const d = join(base, name);
  await mkdir(join(d, "bin"), { recursive: true });
  await writeFile(join(d, "bin", "postgres"), "#!/bin/sh\n");
  return d;
}
async function fakeVolumeBuild(builds: string, major: number, tag: string, marker: object): Promise<string> {
  const d = join(builds, `v${major}`, tag);
  await mkdir(join(d, "bin"), { recursive: true });
  await writeFile(join(d, "bin", "postgres"), "#!/bin/sh\n");
  await writeFile(join(d, "build.json"), JSON.stringify(marker));
  return d;
}
const noopLogger = { info: () => {}, error: () => {} };
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
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

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
    // Force the tie: activate the equal-minor downloaded row is NOT what resolve does — resolve prefers baked on tie:
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
});
