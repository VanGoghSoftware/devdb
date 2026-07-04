import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapEventToKeys, startEvents } from "../src/api/events.js";

describe("mapEventToKeys", () => {
  it("project events invalidate projects and all branch lists", () => {
    expect(mapEventToKeys({ type: "project.created", projectId: "p1", at: "t" }))
      .toEqual([["projects"], ["branches"]]);
  });
  it("branch events invalidate the project's branch list and the branch detail", () => {
    expect(mapEventToKeys({ type: "branch.updated", projectId: "p1", branchId: "b1", at: "t" }))
      .toEqual([["branches", "p1"], ["branch", "b1"]]);
  });
  it("a branch event missing projectId falls back to all branch lists", () => {
    expect(mapEventToKeys({ type: "endpoint.status", branchId: "b1", at: "t" }))
      .toEqual([["branches"], ["branch", "b1"]]);
  });
  it("engine.health invalidates status", () => {
    expect(mapEventToKeys({ type: "engine.health", at: "t" })).toEqual([["status"]]);
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
}

describe("startEvents", () => {
  // FakeEventSource.instances is a module-level static array (brief's own fixture) — reset it per
  // test so instance-count assertions below aren't polluted by instances created in earlier tests.
  beforeEach(() => {
    FakeEventSource.instances = [];
  });

  it("parses valid events, ignores garbage, reports status transitions", () => {
    vi.useFakeTimers();
    const seen: unknown[] = []; const statuses: string[] = [];
    const stop = startEvents({
      onEvent: (e) => seen.push(e),
      onOpen: () => {},
      onStatus: (s) => statuses.push(s),
      makeSource: (url) => new FakeEventSource(url) as unknown as EventSource,
    });
    const es = FakeEventSource.instances.at(-1)!;
    es.onopen?.();
    es.onmessage?.({ data: JSON.stringify({ type: "branch.created", projectId: "p", branchId: "b", at: "t" }) });
    es.onmessage?.({ data: "not json" });
    expect(seen).toHaveLength(1);
    expect(statuses).toEqual(["connecting", "open"]);
    stop();
    expect(es.closed).toBe(true);
    vi.useRealTimers();
  });

  it("reconnects with doubling backoff capped at 10s, resetting on open", () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    startEvents({
      onEvent: () => {}, onOpen: () => {}, onStatus: (s) => statuses.push(s),
      makeSource: (url) => new FakeEventSource(url) as unknown as EventSource,
    });
    FakeEventSource.instances.at(-1)!.onerror?.();          // schedules reconnect at 1s
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances.at(-1)!.onerror?.();          // 2s
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(statuses.filter((s) => s === "reconnecting").length).toBeGreaterThanOrEqual(2);

    // Continue doubling through the cap: 4s, 8s, then capped at 10s (16s would exceed it).
    FakeEventSource.instances.at(-1)!.onerror?.();          // 4s
    vi.advanceTimersByTime(3999);
    expect(FakeEventSource.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(4);

    FakeEventSource.instances.at(-1)!.onerror?.();          // 8s
    vi.advanceTimersByTime(7999);
    expect(FakeEventSource.instances).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(5);

    FakeEventSource.instances.at(-1)!.onerror?.();          // capped at 10s (not 16s)
    vi.advanceTimersByTime(9999);
    expect(FakeEventSource.instances).toHaveLength(5);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(6);

    // A further error still reconnects at the 10s cap, not beyond it.
    FakeEventSource.instances.at(-1)!.onerror?.();          // still capped at 10s
    vi.advanceTimersByTime(9999);
    expect(FakeEventSource.instances).toHaveLength(6);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(7);

    // A successful connection resets the backoff: the NEXT error reconnects after 1s again.
    FakeEventSource.instances.at(-1)!.onopen?.();
    FakeEventSource.instances.at(-1)!.onerror?.();
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(7);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(8);

    vi.useRealTimers();
  });

  it("does not orphan a reconnect timer when onerror fires twice before it runs", () => {
    vi.useFakeTimers();
    const stop = startEvents({
      onEvent: () => {}, onOpen: () => {}, onStatus: () => {},
      makeSource: (url) => new FakeEventSource(url) as unknown as EventSource,
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    // Fire onerror TWICE on the same source before its reconnect timer runs. The buggy
    // implementation schedules a timer on each call, overwriting `timer` the second time —
    // both timers stay registered independently (they were both live setTimeout calls), so
    // the orphaned one still fires connect() later. It doesn't fire at the same instant as
    // the first (delay was doubled to 2s after the second onerror, so the orphan is due at
    // t=2000 while the first reconnect fires at t=1000) — advance well past both boundaries
    // to observe it. A correct implementation ignores the second onerror entirely: only one
    // reconnect timer is ever pending, so only one replacement source is ever created no
    // matter how far time advances.
    FakeEventSource.instances.at(-1)!.onerror?.();
    FakeEventSource.instances.at(-1)!.onerror?.();
    vi.advanceTimersByTime(5000); // past both the legitimate 1s reconnect and the orphan's later fire
    expect(FakeEventSource.instances).toHaveLength(2); // exactly one replacement source, not two

    // After stop(), no further source is ever created, even if a timer were still pending.
    stop();
    vi.advanceTimersByTime(20_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.useRealTimers();
  });
});
