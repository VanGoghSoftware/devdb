// A real (not `declare const`) symbol — the brand's computed property key below is executed at
// runtime when `run()` constructs a lane, so it needs an actual value to key on, not just a type-
// level ambient declaration (which TypeScript erases entirely, leaving no runtime binding).
const laneBrand: unique symbol = Symbol("lane");

/** Capability proving the holder is executing inside a specific branch's queue lane.
 *  Constructable ONLY by BranchQueue.run — the brand cannot be forged externally. */
export interface Lane {
  readonly branchId: string;
  readonly [laneBrand]: true;
}

export class BranchQueue {
  private tails = new Map<string, Promise<unknown>>();

  pendingCount(): number {
    return this.tails.size;
  }

  run<T>(branchId: string, fn: (lane: Lane) => Promise<T>): Promise<T> {
    const lane = { branchId, [laneBrand]: true } as Lane;
    const tail = this.tails.get(branchId) ?? Promise.resolve();
    const next = tail.then(() => fn(lane), () => fn(lane));
    const settled = next.then(() => undefined, () => undefined);
    this.tails.set(branchId, settled);
    void settled.then(() => {
      if (this.tails.get(branchId) === settled) this.tails.delete(branchId);
    });
    return next;
  }
}
