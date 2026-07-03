import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/mcp/session.js";

describe("SessionStore", () => {
  it("sweeps sessions idle past the TTL and closes them", () => {
    const closed: string[] = [];
    const store = new SessionStore({ ttlMs: 1000 });
    const mk = (id: string) => ({ transport: { close: async () => { closed.push(id); } }, server: {}, lastSeen: 0 }) as never;
    store.set("s1", mk("s1"));
    store.set("s2", mk("s2"));
    store.touch("s2", 2000);        // s2 seen at t=2000
    store.sweep(2500);              // t=2500: s1 idle since 0 (>1000) → evicted; s2 fresh
    expect(closed).toEqual(["s1"]);
    expect(store.get("s1")).toBeUndefined();
    expect(store.get("s2")).toBeDefined();
  });
});
