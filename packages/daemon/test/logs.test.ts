import { describe, expect, it } from "vitest";
import { LogsService } from "../src/services/logs.js";

describe("LogsService", () => {
  it("keeps a bounded ring and notifies subscribers", () => {
    const logs = new LogsService(3);
    const got: string[] = [];
    const unsub = logs.subscribe("c", (l) => got.push(l));
    for (const l of ["a", "b", "c", "d"]) logs.ingest("c", l);
    expect(logs.recent("c")).toEqual(["b", "c", "d"]);
    expect(got).toEqual(["a", "b", "c", "d"]);
    unsub();
    logs.ingest("c", "e");
    expect(got).toHaveLength(4);
  });

  it("keeps channels independent — ingest/recent/subscribe on one channel don't affect another", () => {
    const logs = new LogsService(500);
    const gotA: string[] = [];
    const gotB: string[] = [];
    logs.subscribe("a", (l) => gotA.push(l));
    logs.subscribe("b", (l) => gotB.push(l));
    logs.ingest("a", "line-a");
    logs.ingest("b", "line-b");
    expect(logs.recent("a")).toEqual(["line-a"]);
    expect(logs.recent("b")).toEqual(["line-b"]);
    expect(gotA).toEqual(["line-a"]);
    expect(gotB).toEqual(["line-b"]);
  });

  it("recent() on a channel with no ingested lines returns an empty array, not undefined", () => {
    const logs = new LogsService();
    expect(logs.recent("never-touched")).toEqual([]);
  });

  it("recent(channel, n) caps the returned tail to the last n lines", () => {
    const logs = new LogsService(500);
    for (const l of ["a", "b", "c", "d", "e"]) logs.ingest("c", l);
    expect(logs.recent("c", 2)).toEqual(["d", "e"]);
  });

  it("unsubscribing one subscriber does not affect a second subscriber on the same channel", () => {
    const logs = new LogsService();
    const got1: string[] = [];
    const got2: string[] = [];
    const unsub1 = logs.subscribe("c", (l) => got1.push(l));
    logs.subscribe("c", (l) => got2.push(l));
    logs.ingest("c", "a");
    unsub1();
    logs.ingest("c", "b");
    expect(got1).toEqual(["a"]);
    expect(got2).toEqual(["a", "b"]);
  });

  // Fix 3 (review): a channel's subscriber Set must be dropped from the internal map entirely
  // once its last subscriber unsubscribes — not merely left behind, empty, forever. Asserted via
  // a narrowly-scoped cast to this instance's own private `subs` map (no other way to distinguish
  // "the Map entry is truly gone" from "it's an empty-but-still-present Set" through pure
  // black-box behavior — ingest()/recent()/subscribe() behave identically either way).
  it("unsubscribe deletes the channel's Set from the internal map once it's empty", () => {
    const logs = new LogsService();
    const subs = (logs as unknown as { subs: Map<string, Set<unknown>> }).subs;
    const unsub1 = logs.subscribe("c", () => {});
    const unsub2 = logs.subscribe("c", () => {});
    expect(subs.has("c")).toBe(true);

    unsub1();
    // one subscriber remains — the Set itself must still be present (not deleted early).
    expect(subs.has("c")).toBe(true);

    unsub2();
    expect(subs.has("c")).toBe(false);
  });

  // The re-subscribe counterpart: after the map entry is dropped (previous test), a FRESH
  // subscribe() on the same channel name must still work normally — proves the deletion is a
  // pure cleanup, not something that poisons the channel against future subscribers.
  it("a channel can be subscribed to again after its Set was deleted for hitting zero subscribers", () => {
    const logs = new LogsService();
    const unsub1 = logs.subscribe("c", () => {});
    unsub1();
    const got: string[] = [];
    logs.subscribe("c", (l) => got.push(l));
    logs.ingest("c", "line");
    expect(got).toEqual(["line"]);
  });

  // Fix 3 (review): evict() removes BOTH the ring buffer and subscriber Set for a channel — used
  // when a branch is deleted (its `branch:<id>:compute` channel will never be used again).
  describe("evict", () => {
    it("removes the ring buffer — recent() reverts to empty as if the channel were never touched", () => {
      const logs = new LogsService();
      logs.ingest("branch:b1:compute", "line-1");
      expect(logs.recent("branch:b1:compute")).toEqual(["line-1"]);

      logs.evict("branch:b1:compute");

      expect(logs.recent("branch:b1:compute")).toEqual([]);
    });

    it("removes the subscriber Set — a still-subscribed callback stops receiving ingests after evict", () => {
      const logs = new LogsService();
      const got: string[] = [];
      logs.subscribe("branch:b1:compute", (l) => got.push(l));
      logs.ingest("branch:b1:compute", "before-evict");
      expect(got).toEqual(["before-evict"]);

      logs.evict("branch:b1:compute");
      // A subsequent ingest on the evicted channel must not reach the (now-orphaned) callback —
      // evict() dropped the Set outright, not merely cleared it while somehow keeping the ref live.
      logs.ingest("branch:b1:compute", "after-evict");

      expect(got).toEqual(["before-evict"]);
    });

    it("both internal map entries are actually gone, not just behaviorally empty", () => {
      const logs = new LogsService();
      const rings = (logs as unknown as { rings: Map<string, unknown> }).rings;
      const subs = (logs as unknown as { subs: Map<string, unknown> }).subs;
      logs.ingest("branch:b1:compute", "line");
      logs.subscribe("branch:b1:compute", () => {});
      expect(rings.has("branch:b1:compute")).toBe(true);
      expect(subs.has("branch:b1:compute")).toBe(true);

      logs.evict("branch:b1:compute");

      expect(rings.has("branch:b1:compute")).toBe(false);
      expect(subs.has("branch:b1:compute")).toBe(false);
    });

    it("evicting a channel that was never touched is a harmless no-op", () => {
      const logs = new LogsService();
      expect(() => logs.evict("never-touched")).not.toThrow();
      expect(logs.recent("never-touched")).toEqual([]);
    });

    it("evict on one channel does not affect a different channel", () => {
      const logs = new LogsService();
      logs.ingest("branch:b1:compute", "b1-line");
      logs.ingest("branch:b2:compute", "b2-line");

      logs.evict("branch:b1:compute");

      expect(logs.recent("branch:b1:compute")).toEqual([]);
      expect(logs.recent("branch:b2:compute")).toEqual(["b2-line"]);
    });
  });
});
