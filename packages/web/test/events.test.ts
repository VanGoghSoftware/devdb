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
    vi.useRealTimers();
  });
});
