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

  // Fix 1 (review): branding alone only proves a lane came from SOME run() call — it does not
  // prove the holder is still within that call's turn. A lane retained past the turn it was
  // minted for (e.g. stashed by a work fn and returned/leaked) must be rejected by assertLane even
  // though it is a genuine, correctly-branded Lane for the right branchId — this is the whole
  // point of making the capability turn-scoped rather than merely branded.
  it("rejects a lane that leaked out of run() and is presented after its turn has settled", async () => {
    const q = new BranchQueue();
    const leaked = await q.run("branch-1", async (l) => l);
    expect(() => q.assertLane(leaked, "branch-1")).toThrow(/not currently active/);
  });

  it("does NOT throw for a lane presented while still inside its own run() turn", async () => {
    const q = new BranchQueue();
    await q.run("branch-1", async (l) => {
      expect(() => q.assertLane(l, "branch-1")).not.toThrow();
    });
  });
});
