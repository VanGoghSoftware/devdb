import { mkdir, readdir, rm, symlink, rename } from "node:fs/promises";
import { join } from "node:path";

// Composed pg_distrib_dir for the pageserver (spec §Architecture): baked majors ALWAYS win a
// slot (minors must never perturb the storage engine's binaries at runtime); only majors absent
// from the baked install get a downloaded target — that's what gives a pulled v18 WAL-redo bits.
// Callers: index.ts boot (BEFORE EngineRuntime.start() writes/reads pageserver.toml) and
// Provisioner activation. Per-entry atomicity: symlink to a temp name then rename() over the
// slot — a pageserver spawning a walredo mid-recompose reads either the old or the new target,
// never a missing one. oracle: pg_distrib_dir per-major resolution is upstream pageserver
// behavior — see engine/configs.ts pageserverToml's oracle comment (src/daemon/pageserver/mod.rs:67-96).
export async function composePgDistrib(a: {
  distribDir: string; pgInstallDir: string; downloadedOnly: Array<{ major: number; path: string }>;
}): Promise<void> {
  await mkdir(a.distribDir, { recursive: true });
  const targets = new Map<string, string>();
  for (const name of await readdir(a.pgInstallDir)) {
    if (/^v\d+$/.test(name)) targets.set(name, join(a.pgInstallDir, name)); // vanilla_* excluded
  }
  for (const d of a.downloadedOnly) {
    const slot = `v${d.major}`;
    if (!targets.has(slot)) targets.set(slot, d.path); // baked always wins its slot
  }
  for (const [slot, target] of targets) {
    const tmp = join(a.distribDir, `.${slot}.tmp`);
    await rm(tmp, { force: true });
    await symlink(target, tmp);
    await rename(tmp, join(a.distribDir, slot)); // atomic replace over existing symlink
  }
  for (const existing of await readdir(a.distribDir)) {
    if (/^v\d+$/.test(existing) && !targets.has(existing)) {
      await rm(join(a.distribDir, existing), { force: true });
    }
  }
}
