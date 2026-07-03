import { describe, expect, it } from "vitest";
import { BranchQueue } from "../src/state/queue.js";

describe("BranchQueue lane capability", () => {
  it("passes a lane branded with the branchId to the work fn", async () => {
    const q = new BranchQueue();
    const lane = await q.run("branch-1", async (l) => l);
    expect(lane.branchId).toBe("branch-1");
  });

  it("still serializes per branch (lane does not change ordering)", async () => {
    const q = new BranchQueue();
    const order: string[] = [];
    const a = q.run("b", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("a"); });
    const b = q.run("b", async () => { order.push("b"); });
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });
});
