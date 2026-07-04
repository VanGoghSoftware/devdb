import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared scaffold helpers for pg_builds-related tests (BuildRegistry, Provisioner). Extracted from
// pg-build-registry.test.ts (Task 4) so Task 7's provisioner.test.ts doesn't duplicate them.
//
// Callers own cleanup: push every returned root onto their own `dirs` array and `rm` it in
// `afterEach` (see pg-build-registry.test.ts / provisioner.test.ts) — this module intentionally
// holds no test-lifecycle state of its own so it stays usable from any suite.

// A fresh temp root with empty `pg_install` and `pg_builds` subdirs (the two directories a
// BuildRegistry/Provisioner is constructed over). Returns the root itself too, since some callers
// (Provisioner tests) need it for their own scratch dirs (e.g. a jobs-table StateDb, tmp digests).
export async function scaffoldBuildDirs(): Promise<{ root: string; install: string; builds: string }> {
  const root = await mkdtemp(join(tmpdir(), "devdb-reg-"));
  const install = join(root, "pg_install");
  const builds = join(root, "pg_builds");
  await mkdir(install, { recursive: true });
  await mkdir(builds, { recursive: true });
  return { root, install, builds };
}

// A baked-style install dir `<base>/<name>/bin/postgres` (content is a placeholder — the fake
// detectVersion in these tests never actually execs it).
export async function fakeInstallDir(base: string, name: string): Promise<string> {
  const d = join(base, name);
  await mkdir(join(d, "bin"), { recursive: true });
  await writeFile(join(d, "bin", "postgres"), "#!/bin/sh\n");
  return d;
}

// A volume-adopted downloaded build dir `<builds>/v<major>/<tag>/` with `bin/postgres` +
// `build.json` marker already in place (as BuildRegistry.adoptVolumeBuilds expects to find it).
export async function fakeVolumeBuild(builds: string, major: number, tag: string, marker: object): Promise<string> {
  const d = join(builds, `v${major}`, tag);
  await mkdir(join(d, "bin"), { recursive: true });
  await writeFile(join(d, "bin", "postgres"), "#!/bin/sh\n");
  await writeFile(join(d, "build.json"), JSON.stringify(marker));
  return d;
}

export const noopLogger = { info: () => {}, error: () => {} };

// Register a scaffolded root for cleanup. Usage: `const dirs = trackedDirs(); afterEach(() =>
// cleanupDirs(dirs));` — kept as a tiny pair rather than a single class so call sites read exactly
// like the inline `dirs: string[]` array Task 4's test already used.
export function trackedDirs(): string[] {
  return [];
}

export async function cleanupDirs(dirs: string[]): Promise<void> {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}
