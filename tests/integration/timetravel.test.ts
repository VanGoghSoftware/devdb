import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";
import { api, connect } from "./helpers/pg.js";

describe("time travel", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("restores dropped data in place and via new branch", async () => {
    const created = await api<{ project: { id: string }; mainBranch: { id: string } }>(
      dev, "POST", "/api/projects", { name: "tt" });
    const mainId = created.mainBranch.id;

    const ep = await api<{ connectionString: string }>(
      dev, "POST", `/api/branches/${mainId}/endpoint/start`);
    let c = await connect(dev, ep.connectionString);
    await c.query("CREATE TABLE t (v text)");
    await c.query("INSERT INTO t VALUES ('precious')");
    // let WAL land + a clear timestamp gap either side of "before" — get_lsn_by_timestamp needs
    // the commit timestamp to be durably behind the target (see the brief's timing note).
    await new Promise((r) => setTimeout(r, 3000));
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 3000));
    await c.query("DROP TABLE t");
    await c.end();

    // non-destructive: recover into a new branch, leaving mainId's dropped-table state untouched
    const rb = await api<{ id: string }>(
      dev, "POST", `/api/branches/${mainId}/restore`, { mode: "new_branch", to: before, name: "rescued" });
    const rbEp = await api<{ connectionString: string }>(
      dev, "POST", `/api/branches/${rb.id}/endpoint/start`);
    const rc = await connect(dev, rbEp.connectionString);
    expect((await rc.query("SELECT v FROM t")).rows).toEqual([{ v: "precious" }]);
    await rc.end();

    // destructive: restore main itself — in-place identity swap (main keeps its name/id-slot,
    // the pre-restore row is archived under a new name; see TimeTravelService.restoreInPlace).
    const restored = await api<{ id: string; name: string }>(
      dev, "POST", `/api/branches/${mainId}/restore`, { mode: "in_place", to: before });
    expect(restored.name).toBe("main");
    const rEp = await api<{ connectionString: string }>(
      dev, "POST", `/api/branches/${restored.id}/endpoint/start`);
    c = await connect(dev, rEp.connectionString);
    expect((await c.query("SELECT v FROM t")).rows).toEqual([{ v: "precious" }]);
    await c.end();
  });

  it("reset returns a branch to its parent's state", async () => {
    const created = await api<{ project: { id: string }; mainBranch: { id: string } }>(
      dev, "POST", "/api/projects", { name: "rt" });
    const mainId = created.mainBranch.id;
    const ep = await api<{ connectionString: string }>(
      dev, "POST", `/api/branches/${mainId}/endpoint/start`);
    const mc = await connect(dev, ep.connectionString);
    await mc.query("CREATE TABLE base (v text)");
    await mc.query("INSERT INTO base VALUES ('parent-state')");
    await mc.end();

    const br = await api<{ id: string }>(
      dev, "POST", `/api/projects/${created.project.id}/branches`, { name: "scratch" });
    const brEp = await api<{ connectionString: string }>(
      dev, "POST", `/api/branches/${br.id}/endpoint/start`);
    let bc = await connect(dev, brEp.connectionString);
    await bc.query("INSERT INTO base VALUES ('scratch-garbage')");
    await bc.end();

    const reset = await api<{ id: string }>(dev, "POST", `/api/branches/${br.id}/reset`);
    const rEp = await api<{ connectionString: string }>(
      dev, "POST", `/api/branches/${reset.id}/endpoint/start`);
    bc = await connect(dev, rEp.connectionString);
    expect((await bc.query("SELECT count(*)::int AS n FROM base")).rows[0].n).toBe(1);
    await bc.end();
  });
});
