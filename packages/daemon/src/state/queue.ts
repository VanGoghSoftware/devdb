export class BranchQueue {
  private tails = new Map<string, Promise<unknown>>();

  pendingCount(): number {
    return this.tails.size;
  }

  run<T>(branchId: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(branchId) ?? Promise.resolve();
    const next = tail.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(branchId, settled);
    void settled.then(() => {
      if (this.tails.get(branchId) === settled) this.tails.delete(branchId);
    });
    return next;
  }
}
