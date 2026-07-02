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

  it("restoreSwap repoints children not in the reparented list (catch-all)", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });
    const orig = s.branches.create({
      id: crypto.randomUUID(), projectId: p.id, parentBranchId: null,
      name: "main", slug: "acme-main", timelineId: "1".repeat(32), password: "pw", createdBy: "api",
    });
    const child = s.branches.create({
      id: crypto.randomUUID(), projectId: p.id, parentBranchId: orig.id,
      name: "dev", slug: "acme-dev", timelineId: "2".repeat(32), password: "pw2", createdBy: "api",
    });
    const swapped = s.branches.restoreSwap({
      oldBranchId: orig.id, newBranchId: crypto.randomUUID(), newTimelineId: "3".repeat(32),
      archiveName: "main_arch", archiveSlug: "acme-main-arch", reparentedTimelineIds: [],
    });
    expect(s.branches.byId(child.id)!.parentBranchId).toBe(swapped.id);
  });

  it("restoreSwap does not touch same-timeline rows in other projects", () => {
    const s = freshState();
    const p1 = s.projects.create({ id: "a".repeat(32), name: "one", pgVersion: 17 });
    const p2 = s.projects.create({ id: "b".repeat(32), name: "two", pgVersion: 17 });
    const orig = s.branches.create({
      id: crypto.randomUUID(), projectId: p1.id, parentBranchId: null,
      name: "main", slug: "one-main", timelineId: "1".repeat(32), password: "pw", createdBy: "api",
    });
    const otherMain = s.branches.create({
      id: crypto.randomUUID(), projectId: p2.id, parentBranchId: null,
      name: "main", slug: "two-main", timelineId: "9".repeat(32), password: "pw", createdBy: "api",
    });
    const bystander = s.branches.create({
      id: crypto.randomUUID(), projectId: p2.id, parentBranchId: otherMain.id,
      name: "same-timeline", slug: "two-same", timelineId: "2".repeat(32), password: "pw", createdBy: "api",
    });
    s.branches.restoreSwap({
      oldBranchId: orig.id, newBranchId: crypto.randomUUID(), newTimelineId: "3".repeat(32),
      archiveName: "main_arch", archiveSlug: "one-main-arch", reparentedTimelineIds: ["2".repeat(32)],
    });
    expect(s.branches.byId(bystander.id)!.parentBranchId).toBe(otherMain.id);
  });

  it("restoreSwap clears the archived row's sticky port and moves it to the new row", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });
    const orig = s.branches.create({
      id: crypto.randomUUID(), projectId: p.id, parentBranchId: null,
      name: "main", slug: "acme-main", timelineId: "1".repeat(32), password: "pw", createdBy: "api",
    });
    s.branches.setStickyPort(orig.id, 54321);
    const swapped = s.branches.restoreSwap({
      oldBranchId: orig.id, newBranchId: crypto.randomUUID(), newTimelineId: "3".repeat(32),
      archiveName: "main_arch", archiveSlug: "acme-main-arch", reparentedTimelineIds: [],
    });
    expect(s.branches.byId(orig.id)!.stickyPort).toBeNull();
    expect(swapped.stickyPort).toBe(54321);
  });

  it("rejects cross-project parent branches", () => {
    const s = freshState();
    const p1 = s.projects.create({ id: "a".repeat(32), name: "one", pgVersion: 17 });
    const p2 = s.projects.create({ id: "b".repeat(32), name: "two", pgVersion: 17 });
    const parentInP1 = s.branches.create({
      id: crypto.randomUUID(), projectId: p1.id, parentBranchId: null,
      name: "main", slug: "one-main", timelineId: "1".repeat(32), password: "pw", createdBy: "api",
    });
    expect(() => s.branches.create({
      id: crypto.randomUUID(), projectId: p2.id, parentBranchId: parentInP1.id,
      name: "bad", slug: "two-bad", timelineId: "2".repeat(32), password: "pw", createdBy: "api",
    })).toThrow(/FOREIGN KEY/);
  });

  it("BranchQueue continues after a rejected mutation", async () => {
    const q = new BranchQueue();
    const order: string[] = [];
    const first = q.run("b1", async () => { throw new Error("boom"); });
    const second = q.run("b1", async () => { order.push("second"); });
    await expect(first).rejects.toThrow("boom");
    await second;
    expect(order).toEqual(["second"]);
  });

  it("BranchQueue evicts settled tails", async () => {
    const q = new BranchQueue();
    await q.run("b1", async () => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(q.pendingCount()).toBe(0);
  });
});
