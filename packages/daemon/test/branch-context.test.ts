import { describe, expect, it } from "vitest";
import { openState } from "../src/state/db.js";

describe("branch context persistence", () => {
  it("round-trips a context object through create + byId", () => {
    const state = openState(":memory:");
    const p = state.projects.create({ id: "p1", name: "proj", pgVersion: 17 });
    const ctx = { git_branch: "feat/x", workdir: "/w", agent: "claude", purpose: "try a migration" };
    const b = state.branches.create({
      id: "b1", projectId: p.id, parentBranchId: null, name: "main",
      slug: "proj-main-abc123", timelineId: "t".repeat(32), password: "pw", createdBy: "mcp",
      context: ctx,
    });
    expect(b.context).toEqual(ctx);
    expect(state.branches.byId("b1")?.context).toEqual(ctx);
  });

  it("defaults context to null when omitted", () => {
    const state = openState(":memory:");
    state.projects.create({ id: "p1", name: "proj", pgVersion: 17 });
    const b = state.branches.create({
      id: "b1", projectId: "p1", parentBranchId: null, name: "main",
      slug: "s", timelineId: "t".repeat(32), password: "pw", createdBy: "api",
    });
    expect(b.context).toBeNull();
  });
});
