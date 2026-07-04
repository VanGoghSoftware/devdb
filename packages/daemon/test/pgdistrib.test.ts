import { mkdtemp, mkdir, rm, readlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composePgDistrib } from "../src/compute/builds/pgdistrib.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function scaffold() {
  const root = await mkdtemp(join(tmpdir(), "devdb-distrib-"));
  dirs.push(root);
  const install = join(root, "pg_install");
  for (const v of ["v16", "v17", "vanilla_v17"]) await mkdir(join(install, v), { recursive: true });
  const dl18 = join(root, "pg_builds", "v18", "9200");
  await mkdir(dl18, { recursive: true });
  return { root, install, dl18, distrib: join(root, "pg_distrib") };
}

describe("composePgDistrib", () => {
  it("baked majors always point at baked dirs; downloaded-only majors at their build; vanilla excluded", async () => {
    const { install, dl18, distrib } = await scaffold();
    await composePgDistrib({ distribDir: distrib, pgInstallDir: install, downloadedOnly: [{ major: 18, path: dl18 }] });
    expect(await readlink(join(distrib, "v16"))).toBe(join(install, "v16"));
    expect(await readlink(join(distrib, "v17"))).toBe(join(install, "v17"));
    expect(await readlink(join(distrib, "v18"))).toBe(dl18);
    expect((await readdir(distrib)).sort()).toEqual(["v16", "v17", "v18"]);
  });

  it("recompose replaces stale links atomically (no ENOENT window) and drops removed majors", async () => {
    const { install, dl18, distrib } = await scaffold();
    await composePgDistrib({ distribDir: distrib, pgInstallDir: install, downloadedOnly: [{ major: 18, path: dl18 }] });
    await composePgDistrib({ distribDir: distrib, pgInstallDir: install, downloadedOnly: [] });
    expect((await readdir(distrib)).sort()).toEqual(["v16", "v17"]);
    // A baked major that ALSO has a downloaded build still points at BAKED — the invariant:
    await composePgDistrib({ distribDir: distrib, pgInstallDir: install, downloadedOnly: [{ major: 17, path: dl18 }] });
    expect(await readlink(join(distrib, "v17"))).toBe(join(install, "v17"));
  });
});
