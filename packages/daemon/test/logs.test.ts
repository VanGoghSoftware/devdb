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
});
