import { describe, expect, it } from "vitest";
import { openState } from "../src/state/db.js";
import { BranchQueue } from "../src/state/queue.js";

function freshState() {
  return openState(":memory:");
}

describe("state", () => {
  it("creates and fetches projects and branches", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });
    const b = s.branches.create({
      id: crypto.randomUUID(), projectId: p.id, parentBranchId: null,
      name: "main", slug: "acme-main", timelineId: "b".repeat(32),
      password: "pw", createdBy: "api",
    });
    expect(s.projects.byName("acme")?.id).toBe(p.id);
    expect(s.branches.byProjectAndName(p.id, "main")?.id).toBe(b.id);
    expect(s.branches.listByProject(p.id)).toHaveLength(1);
    expect(b.endpointStatus).toBe("stopped");
  });

  it("enforces unique branch name per project", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });
    const mk = () => s.branches.create({
      id: crypto.randomUUID(), projectId: p.id, parentBranchId: null,
      name: "main", slug: crypto.randomUUID(), timelineId: "c".repeat(32),
      password: "pw", createdBy: "api",
    });
    mk();
    expect(mk).toThrow();
  });

  it("restoreSwap archives old branch and moves identity to new row", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });
    const orig = s.branches.create({
      id: crypto.randomUUID(), projectId: p.id, parentBranchId: null,
      name: "main", slug: "acme-main", timelineId: "1".repeat(32),
      password: "pw", createdBy: "api",
    });
    const child = s.branches.create({
      id: crypto.randomUUID(), projectId: p.id, parentBranchId: orig.id,
      name: "dev", slug: "acme-dev", timelineId: "2".repeat(32),
      password: "pw2", createdBy: "api",
    });
    const swapped = s.branches.restoreSwap({
      oldBranchId: orig.id, newBranchId: crypto.randomUUID(),
      newTimelineId: "3".repeat(32), archiveName: "main_pitr_archived_x",
      archiveSlug: "acme-main-arch", reparentedTimelineIds: [child.timelineId],
    });
    expect(swapped.name).toBe("main");
    expect(swapped.slug).toBe("acme-main");
    expect(swapped.timelineId).toBe("3".repeat(32));
    const archived = s.branches.byId(orig.id)!;
    expect(archived.name).toBe("main_pitr_archived_x");
    // child whose timeline was reparented now points at the new branch row
    expect(s.branches.byId(child.id)!.parentBranchId).toBe(swapped.id);
  });

  it("BranchQueue serializes per branch", async () => {
    const q = new BranchQueue();
    const order: string[] = [];
    await Promise.all([
      q.run("b1", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("first"); }),
      q.run("b1", async () => { order.push("second"); }),
    ]);
    expect(order).toEqual(["first", "second"]);
  });
});
