// A real (not `declare const`) symbol — the brand's computed property key below is executed at
// runtime when `run()` constructs a lane, so it needs an actual value to key on, not just a type-
// level ambient declaration (which TypeScript erases entirely, leaving no runtime binding).
// NEVER export `laneBrand`: doing so would let any external file spell the exact computed key and
// forge a structurally-valid `Lane` object literal, defeating the whole point of this brand.
const laneBrand: unique symbol = Symbol("lane");

/** Capability proving the holder is executing inside a specific branch's queue lane.
 *  Constructable ONLY by BranchQueue.run — the brand cannot be forged externally. */
export interface Lane {
  readonly branchId: string;
  readonly [laneBrand]: true;
}

export class BranchQueue {
  private tails = new Map<string, Promise<unknown>>();
  // Fix 1 (review): a Lane is branded (proves it came from SOME run() call) but that alone does
  // not prove the holder is still WITHIN that call's active turn — a caller could stash a lane
  // that leaked out of a work fn and present it later, outside serialization, and the old
  // branchId-only assertLane would happily accept it. activeLanes tracks exactly the lanes
  // currently mid-flight inside a work fn invocation; assertLane below rejects anything else, even
  // if it is a genuine, correctly-branded Lane for the right branchId.
  private activeLanes = new WeakSet<Lane>();

  pendingCount(): number {
    return this.tails.size;
  }

  run<T>(branchId: string, fn: (lane: Lane) => Promise<T>): Promise<T> {
    const lane = { branchId, [laneBrand]: true } as Lane;
    // Mark the lane active for the exact span of fn's execution — added immediately before the
    // call, removed once fn's returned promise settles (success OR failure), via .finally() so
    // both outcomes clear it. This must wrap ONLY the fn(lane) call itself, not the existing
    // tail-chaining below, so per-branch serialization ordering/cleanup is unchanged.
    const invoke = (): Promise<T> => {
      this.activeLanes.add(lane);
      return fn(lane).finally(() => this.activeLanes.delete(lane));
    };
    const tail = this.tails.get(branchId) ?? Promise.resolve();
    const next = tail.then(invoke, invoke);
    const settled = next.then(() => undefined, () => undefined);
    this.tails.set(branchId, settled);
    void settled.then(() => {
      if (this.tails.get(branchId) === settled) this.tails.delete(branchId);
    });
    return next;
  }

  /** Throws unless `lane` is BOTH currently active (mid-turn inside some run() call) AND branded
   *  for `branchId` — callers (EndpointsService's startLocked/stopLocked) use this to prove at
   *  runtime that the lane they were handed still authorizes operating on this exact branch. */
  assertLane(lane: Lane, branchId: string): void {
    if (!this.activeLanes.has(lane)) {
      throw new Error(`lane invariant: held lane for ${lane.branchId} is not currently active (used outside its queue turn)`);
    }
    if (lane.branchId !== branchId) {
      throw new Error(`lane invariant: held lane is for ${lane.branchId}, not ${branchId}`);
    }
  }
}
