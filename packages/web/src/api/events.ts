import { DevdbEventSchema, type DevdbEvent } from "@devdb/shared";
import type { QueryKey } from "@tanstack/react-query";
import { keys } from "./keys.js";

// Invalidation map (spec Decision 1): events are hints; REST is truth. Coarse on purpose.
export function mapEventToKeys(e: DevdbEvent): QueryKey[] {
  switch (e.type) {
    case "project.created":
    case "project.deleted":
      return [[...keys.projects], [...keys.allBranches]];
    case "branch.created":
    case "branch.updated":
    case "branch.deleted":
    case "endpoint.status": {
      const list: QueryKey = e.projectId ? [...keys.branches(e.projectId)] : [...keys.allBranches];
      return e.branchId ? [list, [...keys.branch(e.branchId)]] : [list];
    }
    case "engine.health":
      return [[...keys.status]];
  }
}

export type EventsStatus = "connecting" | "open" | "reconnecting";

// EventSource wrapper with explicit capped backoff (1s → 10s, reset on open). Native EventSource
// auto-retry exists but gives no status signal and no cap control — we own the lifecycle so the
// top-bar dot can show truth. `makeSource` is injectable: jsdom has no EventSource.
export function startEvents(a: {
  onEvent: (e: DevdbEvent) => void;
  onOpen: () => void;
  onStatus: (s: EventsStatus) => void;
  makeSource?: (url: string) => EventSource;
}): () => void {
  const make = a.makeSource ?? ((u: string) => new EventSource(u));
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = 1000;
  let stopped = false;
  let everOpened = false;

  const connect = () => {
    if (stopped) return;
    a.onStatus(everOpened ? "reconnecting" : "connecting");
    es = make("/api/events");
    es.onopen = () => {
      everOpened = true;
      delay = 1000; // reset backoff
      a.onStatus("open");
      a.onOpen(); // blanket invalidate on EVERY (re)connect — the no-replay contract's other half
    };
    es.onmessage = (m) => {
      try {
        const parsed = DevdbEventSchema.safeParse(JSON.parse(m.data as string));
        if (parsed.success) a.onEvent(parsed.data);
      } catch {
        // garbage on the stream is ignored — hints only, REST is truth
      }
    };
    es.onerror = () => {
      es?.close();
      // A reconnect is already pending (or we're stopped) — don't schedule a second one.
      // Without this guard, a second onerror before the first timer fires would overwrite
      // `timer`'s handle, orphaning the first timer; it still fires connect() later, leaking
      // a duplicate live EventSource and duplicate invalidations.
      if (stopped || timer !== null) return;
      a.onStatus("reconnecting");
      timer = setTimeout(() => {
        timer = null; // clear BEFORE connect() so a later error can schedule the next reconnect
        connect();
      }, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };

  connect();
  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    es?.close();
  };
}
