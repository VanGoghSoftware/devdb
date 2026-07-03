import { describe, expect, it } from "vitest";
import { SessionStore, type McpSession } from "../src/mcp/session.js";

// Fix 5: a properly-typed minimal McpSession fake (replaces the `as never` cast the review gate
// flagged) — this is a genuine structural subtype of McpSession (transport.close/handleRequest,
// optional sessionId, server.close), so TypeScript checks every call site the real store makes
// against it, proving the store's contract against a real shape rather than an opaque cast.
function fakeSession(onClose: () => void): McpSession {
  return {
    transport: {
      close: async () => { onClose(); },
      handleRequest: async () => {},
      sessionId: undefined,
    },
    server: { close: async () => {} },
    lastSeen: 0,
  };
}

describe("SessionStore", () => {
  it("sweeps sessions idle past the TTL and closes them", () => {
    const closed: string[] = [];
    const store = new SessionStore({ ttlMs: 1000 });
    const mk = (id: string) => {
      const s = fakeSession(() => closed.push(id));
      return s;
    };
    store.set("s1", mk("s1"));
    store.set("s2", mk("s2"));
    store.touch("s2", 2000);        // s2 seen at t=2000
    store.sweep(2500);              // t=2500: s1 idle since 0 (>1000) → evicted; s2 fresh
    expect(closed).toEqual(["s1"]);
    expect(store.get("s1")).toBeUndefined();
    expect(store.get("s2")).toBeDefined();
  });

  it("delete() removes the entry and closes the transport exactly once", async () => {
    let closeCount = 0;
    const store = new SessionStore({ ttlMs: 1000 });
    store.set("s1", fakeSession(() => { closeCount += 1; }));

    await store.delete("s1");

    expect(store.get("s1")).toBeUndefined();
    expect(closeCount).toBe(1);
  });

  it("delete() on an already-removed id is a no-op (idempotent, no double-close)", async () => {
    let closeCount = 0;
    const store = new SessionStore({ ttlMs: 1000 });
    store.set("s1", fakeSession(() => { closeCount += 1; }));

    await store.delete("s1");
    await store.delete("s1"); // second call: entry already gone

    expect(closeCount).toBe(1);
  });

  it("closeAll() closes every session exactly once and empties the store", async () => {
    let closeCount = 0;
    const store = new SessionStore({ ttlMs: 1000 });
    store.set("s1", fakeSession(() => { closeCount += 1; }));
    store.set("s2", fakeSession(() => { closeCount += 1; }));

    await store.closeAll();

    expect(closeCount).toBe(2);
    expect(store.get("s1")).toBeUndefined();
    expect(store.get("s2")).toBeUndefined();
  });

  // Fix 2's core regression test. The bug: `transport.onclose` used to call `store.delete(id)`,
  // and `store.delete` calls `transport.close()` — so on the CLIENT-DISCONNECT path (the SDK
  // closes the transport → onclose fires while the entry is still present → store.delete closes
  // the transport a SECOND time), the transport got closed twice. The fix separates removal
  // (what onclose does) from closing (what WE-initiated teardown does): http.ts's onclose now
  // calls ONLY a pure-removal store method — never store.delete()/transport.close() — while
  // delete()/sweep()/closeAll() (the paths WE initiate) remain the sole owners of
  // transport.close(). removeEntry() is exactly that pure-removal primitive.
  describe("Fix 2 — removeEntry() is pure map-removal; delete()/sweep()/closeAll() own close()", () => {
    it("removeEntry() removes the map entry WITHOUT calling transport.close() — this is what onclose wires to", () => {
      let closeCount = 0;
      const store = new SessionStore({ ttlMs: 1000 });
      store.set("s1", fakeSession(() => { closeCount += 1; }));

      store.removeEntry("s1");

      expect(store.get("s1")).toBeUndefined();
      expect(closeCount).toBe(0); // the whole point of Fix 2: removal must not trigger a close
    });

    it("removeEntry() on an unknown id is a harmless no-op", () => {
      const store = new SessionStore({ ttlMs: 1000 });
      expect(() => store.removeEntry("never-existed")).not.toThrow();
    });

    it("SDK-initiate path: removeEntry() then delete() on the same id closes zero times (entry already gone — delete() is idempotent, not a second close)", async () => {
      // Models the real onclose wiring end-to-end: the SDK fires onclose (→ removeEntry, no
      // close call) BEFORE any of our own code calls delete() on that id (e.g. a racing
      // DELETE /mcp request that arrived just as the client disconnected) — the second call
      // must be a no-op, not a second transport.close().
      let closeCount = 0;
      const store = new SessionStore({ ttlMs: 1000 });
      store.set("s1", fakeSession(() => { closeCount += 1; }));

      store.removeEntry("s1");   // SDK-initiate: onclose fires, pure removal, zero closes
      await store.delete("s1");  // a subsequent delete() finds nothing left to close

      expect(closeCount).toBe(0);
    });

    it("WE-initiate path: delete() still closes the transport exactly once (Fix 2 does not regress the normal teardown path)", async () => {
      let closeCount = 0;
      const store = new SessionStore({ ttlMs: 1000 });
      store.set("s1", fakeSession(() => { closeCount += 1; }));

      await store.delete("s1"); // WE-initiate: delete() is the sole owner of transport.close()

      expect(closeCount).toBe(1);
      expect(store.get("s1")).toBeUndefined();
    });
  });
});
