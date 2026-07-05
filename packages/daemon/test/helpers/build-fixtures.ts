import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StateDb } from "../../src/state/db.js";
import type { PgBuildRow } from "../../src/state/repos.js";
import { shortDigest } from "../../src/compute/builds/registry.js";

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

export interface VolumeMarker { digest: string; tag: string; major: number; minor: number; extractedAt: string }

// A volume-adopted downloaded build dir with `bin/postgres` + `build.json` in place. Production names
// these dirs by CONTENT ADDRESS — `v{major}/{shortDigest(marker.digest)}` — and FIX-6's
// adoptVolumeBuilds enforces it (the dir basename must equal shortDigest of the marker's digest), so
// the dir is DERIVED from the marker here, not from a caller-chosen name. `tag` is retained only for
// call-site readability (callers pass it == marker.tag); it no longer influences the dir. For a
// deliberately-INCONSISTENT dir (which FIX-6 must reject), use fakeVolumeBuildNamed.
export async function fakeVolumeBuild(builds: string, major: number, tag: string, marker: VolumeMarker): Promise<string> {
  return fakeVolumeBuildNamed(builds, major, shortDigest(marker.digest), marker);
}

// Like fakeVolumeBuild but with an EXPLICIT dir basename — for negatives that need the dir to
// disagree with shortDigest(marker.digest), or a malformed marker (marker: object accepts any shape).
export async function fakeVolumeBuildNamed(builds: string, major: number, dirName: string, marker: object): Promise<string> {
  const d = join(builds, `v${major}`, dirName);
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

// Test-only lookup by (major, releaseTag). Production code never addresses a build this way — tags
// are metadata, ids/digests are identity (content-addressed storage can legitimately hold several
// rows at one (major, tag)) — so this convenience lives here, not on PgBuildsRepo (#12).
export function buildByMajorAndTag(state: StateDb, major: number, tag: string): PgBuildRow | null {
  return state.pgBuilds.list().find((r) => r.major === major && r.releaseTag === tag) ?? null;
}
