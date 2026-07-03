import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("phase-1 acceptance (spec v1 items 1-4, REST edition)", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("boot → project → write → branch → isolate → reset → restore", async () => {
    // 1. healthy boot
    expect((await (await fetch(`${dev.base}/api/status`)).json()).healthy).toBe(true);

    // 2. project + main + SQL write (SQL console doubles as the write path here)
    const created = await (await fetch(`${dev.base}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    })).json();
    const mainId = created.mainBranch.id as string;
    const sql = (q: string, branchId = mainId) =>
      fetch(`${dev.base}/api/sql`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ branchId, query: q }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      });
    await sql("CREATE TABLE notes (body text)");
    await sql("INSERT INTO notes VALUES ('hello devdb')");

    // 3. branch is isolated
    const br = await (await fetch(`${dev.base}/api/projects/${created.project.id}/branches`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "agent/demo-task" }),
    })).json();
    await sql("DELETE FROM notes", br.id);
    expect((await sql("SELECT count(*)::int AS n FROM notes")).rows[0].n).toBe(1);

    // Cheap addition: the branch tree is intact via the listing endpoint — parent/child links,
    // not just each branch's own isolated data. Both main and the just-created branch must show
    // up under the project, and the branch's parentBranchId must point back at main.
    const tree = await (await fetch(`${dev.base}/api/projects/${created.project.id}/branches`)).json();
    expect(tree.map((b: { id: string }) => b.id).sort()).toEqual([mainId, br.id].sort());
    const brInTree = tree.find((b: { id: string }) => b.id === br.id);
    expect(brInTree.parentBranchId).toBe(mainId);
    const mainInTree = tree.find((b: { id: string }) => b.id === mainId);
    expect(mainInTree.parentBranchId).toBeNull();

    // 4. reset brings the branch back to parent state
    const reset = await (await fetch(`${dev.base}/api/branches/${br.id}/reset`, { method: "POST" })).json();
    expect((await sql("SELECT count(*)::int AS n FROM notes", reset.id)).rows[0].n).toBe(1);

    // Cheap addition: the swapped-in branch's endpoint came back up clean after reset — no
    // stranded error from the stop/restart TimeTravelService.resetToParent does around the swap
    // (see swapOntoNewTimeline's wasRunning stop-then-restart in services/timetravel.ts).
    const resetDetail = await (await fetch(`${dev.base}/api/branches/${reset.id}`)).json();
    expect(resetDetail.endpointError).toBeNull();
  });
});
