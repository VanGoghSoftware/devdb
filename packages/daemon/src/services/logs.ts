// Bounded ring buffer per channel + live subscriber fanout. Channels: `daemon:<component>`
// (engine-process output — storcon_db, storage_broker, storage_controller, safekeeper,
// pageserver) and `branch:<branchId>:compute` (a running compute's stdout/stderr). Consumers:
// SSE routes in http/api.ts replay recent() then subscribe() for the live tail.
export class LogsService {
  private rings = new Map<string, string[]>();
  private subs = new Map<string, Set<(line: string) => void>>();

  constructor(private ringSize = 500) {}

  ingest(channel: string, line: string): void {
    let ring = this.rings.get(channel);
    if (!ring) { ring = []; this.rings.set(channel, ring); }
    ring.push(line);
    if (ring.length > this.ringSize) ring.shift();
    // Snapshot before iterating: a subscriber that unsubscribes itself (or another) from
    // inside its own callback must not mutate the Set out from under this forEach.
    for (const cb of [...(this.subs.get(channel) ?? [])]) {
      try {
        cb(line);
      } catch {
        // A throwing subscriber (e.g. a client disconnect mid-write) must never break ingest
        // for the rest of the fanout or for the process producing these lines — same swallow
        // contract as ManagedProcess's onLine and ComputeManager's listener fanout.
      }
    }
  }

  recent(channel: string, n = 200): string[] {
    return (this.rings.get(channel) ?? []).slice(-n);
  }

  subscribe(channel: string, cb: (line: string) => void): () => void {
    let set = this.subs.get(channel);
    if (!set) { set = new Set(); this.subs.set(channel, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }
}
