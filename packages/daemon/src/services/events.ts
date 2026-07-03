import type { DevdbEvent, DevdbEventType } from "@devdb/shared";

// In-process state-change fanout behind GET /api/events (spec Decision 1). Events are coarse
// invalidation hints — publishers pass ids only; `at` is stamped here. Deliberately NO ring
// buffer / replay (unlike LogsService): the SSE contract is "future events only; the client
// blanket-invalidates on every (re)connect", so missed events have no correctness consequences.
export class EventsService {
  private subs = new Set<(e: DevdbEvent) => void>();

  publish(e: { type: DevdbEventType; projectId?: string; branchId?: string }): void {
    const evt: DevdbEvent = { ...e, at: new Date().toISOString() };
    // Snapshot before iterating — a subscriber unsubscribing (itself or another) mid-publish
    // must not mutate the Set out from under this loop. Same shape as LogsService.ingest.
    for (const cb of [...this.subs]) {
      try {
        cb(evt);
      } catch {
        // A throwing subscriber (e.g. an SSE write against a dying socket) must never break
        // delivery to other subscribers or the publishing mutation — swallow by contract.
      }
    }
  }

  subscribe(cb: (e: DevdbEvent) => void): () => void {
    this.subs.add(cb);
    return () => { this.subs.delete(cb); };
  }
}
