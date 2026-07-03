import type { IncomingMessage, ServerResponse } from "node:http";

// Session registry for the stateful /mcp transport (Task 8). Each entry pairs the SDK transport
// (whose .close() tears down its SSE/HTTP plumbing) with the per-session McpServer and a
// last-seen timestamp used by the idle sweep. Deliberately holds only the two objects the guard
// and sweep need to act on — no session-scoped business state lives here (that stays inside the
// SDK's own transport/server objects).
//
// `handleRequest`'s parameter types are the real Node.js req/res shapes StreamableHTTPServerTransport
// accepts (sdk-notes.md's `handleRequest(req: IncomingMessage & {auth?}, res: ServerResponse,
// parsedBody?: unknown)`), not an opaque `(...a: never[])` — a never-rest-param function type
// is only callable with zero arguments, which would make every real call site in http.ts a type
// error. Typing the real params keeps this interface a genuine structural subtype of the SDK
// transport (so `store.set(id, {transport, ...})` still accepts the concrete
// StreamableHTTPServerTransport with no cast) while still decoupling SessionStore itself from
// importing the SDK.
export interface McpSession {
  transport: {
    close: () => Promise<void>;
    handleRequest: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>;
    sessionId?: string;
  };
  server: { close: () => Promise<void> };
  lastSeen: number;
}

export class SessionStore {
  private sessions = new Map<string, McpSession>();
  constructor(private opts: { ttlMs: number }) {}

  set(id: string, s: McpSession): void {
    this.sessions.set(id, s);
  }

  get(id: string): McpSession | undefined {
    return this.sessions.get(id);
  }

  touch(id: string, now: number): void {
    const s = this.sessions.get(id);
    if (s) s.lastSeen = now;
  }

  size(): number {
    return this.sessions.size;
  }

  // Pure map removal — never calls transport.close(). This is the primitive http.ts's
  // transport.onclose callback wires to (Fix 2): onclose fires when the transport closes for ANY
  // reason, including a close WE initiated via delete()/sweep()/closeAll() below — all three of
  // which already call transport.close() themselves. If onclose ALSO called close() (e.g. via the
  // old `store.delete(id)` wiring), the client-disconnect path (SDK closes the transport on its
  // own, entry still present, onclose fires) would close the transport a SECOND time. Keeping
  // "remove from the map" and "close the transport" as two separate, single-owner operations is
  // what makes both call paths (WE-initiate vs SDK-initiate) idempotent with respect to each
  // other — whichever runs first, the second sees nothing left to act on.
  removeEntry(id: string): void {
    this.sessions.delete(id);
  }

  // Removes the session immediately AND closes its transport — the single-entry "remove + close"
  // primitive that sweep()/closeAll() below each reimplement inline for their own multi-entry
  // loops (Map.delete(id) + transport.close(), the same two steps, applied to one entry at a
  // time). Fix 4 (wave 2): NOT actually called from src/ — the DELETE /mcp route (http.ts's
  // requireSession) hands off to the SDK's own transport.handleRequest(), which internally closes
  // the transport and fires transport.onclose → removeEntry() (pure removal, no close call; see
  // removeEntry()'s own doc comment) — so this method has no production caller of its own. It is
  // kept and exercised directly by mcp-session.test.ts as a unit-level proof of the exact
  // remove+close contract sweep()/closeAll() both rely on (in particular the idempotent
  // no-double-close interaction with removeEntry()/onclose covered by that test file's "Fix 2"
  // describe block) — not because it currently sits on any live request path. Swallows close()
  // failures — an already-dead transport erroring on close must not block eviction of the
  // session-store entry itself. Idempotent with removeEntry()/onclose: if the entry is already
  // gone (e.g. the SDK's own onclose already fired and called removeEntry() first), this is a
  // no-op — it does NOT call transport.close() a second time on an entry it no longer holds.
  async delete(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.transport.close().catch(() => {});
  }

  // Evicts every session whose lastSeen is more than ttlMs behind `now`. Synchronous by design —
  // the eviction decision (Map.delete) happens immediately so a concurrent touch() racing the
  // sweep can't observe a half-evicted entry; the transport's close() is fired-and-forgotten
  // (same swallow contract as delete()) since the caller (the sweep interval) has nothing
  // meaningful to do with a close failure other than log it, which the transport/SDK already does.
  sweep(now: number): void {
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > this.opts.ttlMs) {
        this.sessions.delete(id);
        void s.transport.close().catch(() => {});
      }
    }
  }

  // Drains the whole store on daemon shutdown (registerMcp's closeAll, wired into api.ts's
  // preClose). Awaited (unlike sweep's fire-and-forget) so the daemon's shutdown sequencing can
  // rely on every MCP transport having actually closed before proceeding.
  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.transport.close().catch(() => {})));
  }
}
