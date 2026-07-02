import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";
import { api, connect } from "./helpers/pg.js";

// Review fix: bounded poll replacing a fixed sleep. GET .../lsn?timestamp=<isoTimestamp> returns
// 200 once get_lsn_by_timestamp resolves that instant to `kind: "present"`, 400 with
// `kind: "future"` while it isn't yet.
//
// CONFIRMED live (direct repro against a standalone container, held for 40+ seconds with zero
// further writes): `kind: "future"` is NOT a wall-clock/ingestion-lag condition that resolves on
// its own with the mere passage of time — it only flips to `kind: "present"` once the pageserver
// has ingested a WAL record whose commit timestamp is AFTER the queried instant. A target
// timestamp held at `kind: "future"` for 40+ seconds of pure waiting resolved to 200 on the very
// next poll, immediately after a single unrelated write landed — proving the mechanism is
// "has anything committed past this point," not "has enough time elapsed." A polling loop with
// no write activity of its own converging on this condition would spin for its entire budget and
// then fail — so this must be called only AFTER some write that commits after `isoTimestamp` is
// already known to have landed (the call site below places it right after the DROP TABLE, which
// is exactly such a write, and which the test needs to run anyway).
//
// Raw fetch (not the `api()` helper) because `api()` throws on any non-2xx/201/204 status, which
// would abort the loop on the very 400s this is meant to poll past.
async function waitForLsnResolvable(dev: Devdb, branchId: string, isoTimestamp: string): Promise<void> {
  const path = `/api/branches/${branchId}/lsn?timestamp=${encodeURIComponent(isoTimestamp)}`;
  let lastBody = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(`${dev.base}${path}`);
    if (res.status === 200) return;
    lastBody = await res.text();
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`GET ${path} never returned 200 within ~10s of polling — last response body: ${lastBody}`);
}

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
    // let WAL land — get_lsn_by_timestamp needs the commit timestamp to be durably behind the
    // target (see the brief's timing note). This gap is a real WAL-durability wait with no
    // observable external condition to poll for, so it stays a fixed sleep.
    await new Promise((r) => setTimeout(r, 3000));
    const before = new Date().toISOString();
    await c.query("DROP TABLE t");
    // Review fix: the second fixed sleep formerly here existed only to put a clear gap between
    // `before` and the DROP TABLE above landing, so that get_lsn_by_timestamp(before) would later
    // resolve to `kind: "present"` once the restore call downstream queried it. The DROP TABLE
    // above is itself the write that makes `before` resolvable (see waitForLsnResolvable's doc
    // comment for why waiting alone, without that write, would never do it) — so the bounded poll
    // belongs HERE, right after that write lands, confirming the real condition this test actually
    // depends on before moving on, instead of a fixed delay that either under- or over-shoots it.
    await waitForLsnResolvable(dev, mainId, before);
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
