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
    // Fix 3 (review): drop the channel's Set entirely once its last subscriber unsubscribes,
    // rather than leaving an empty Set sitting in the map forever. A long-lived daemon serving
    // many short-lived branches (each with its own `branch:<id>:compute` channel that gets
    // subscribed-to once per SSE client, then unsubscribed on disconnect) would otherwise
    // accumulate one permanently-empty Set per distinct channel ever subscribed to, unbounded
    // over the daemon's lifetime — a slow memory leak with no cap, distinct from (and in addition
    // to) the ring-buffer eviction evict() below handles.
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.subs.delete(channel);
    };
  }

  // Fix 3 (review): removes BOTH the ring buffer and subscriber Set for a channel outright —
  // called when the channel's underlying subject is gone for good (a deleted branch's
  // `branch:<id>:compute` channel will never be ingested to or subscribed to again, since branch
  // ids are never reused). Without this, every branch ever created (however briefly) leaves a
  // ring buffer entry in `rings` permanently, even long after the branch — and the compute that
  // produced those lines — no longer exist: an unbounded leak keyed by a strictly-growing set of
  // historical branch ids, on a daemon that otherwise runs indefinitely.
  evict(channel: string): void {
    this.rings.delete(channel);
    this.subs.delete(channel);
  }
}
