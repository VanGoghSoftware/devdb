export class BranchQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(branchId: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(branchId) ?? Promise.resolve();
    const next = tail.then(fn, fn);
    this.tails.set(branchId, next.catch(() => undefined));
    return next;
  }
}
