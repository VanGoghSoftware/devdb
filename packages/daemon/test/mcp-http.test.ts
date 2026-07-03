import { describe, expect, it } from "vitest";
import { connect } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/http/api.js";
import type { EngineRuntime } from "../src/engine/boot.js";
import type { ProjectsService } from "../src/services/projects.js";
import type { BranchesService } from "../src/services/branches.js";
import type { EndpointsService } from "../src/services/endpoints.js";
import type { TimeTravelService } from "../src/services/timetravel.js";
import type { SqlService } from "../src/services/sql.js";
import { LogsService } from "../src/services/logs.js";
import { loadConfig } from "../src/config.js";
import { openState } from "../src/state/db.js";

// Same fake-Deps pattern as test/api.test.ts (fakeEngine/fakeProjects/etc.) — only the fields
// registerMcp's guard hook and its 400 "no session" branch touch need to exist; nothing here
// reaches an actual service call, since every request below either 403s in the onRequest hook
// or 400s on isInitializeRequest before any route logic runs.
function fakeDeps(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    DEVDB_DATA_DIR: "/tmp/devdb-mcp-http-test-only",
    NEON_BINARIES_DIR: "/tmp/devdb-mcp-http-test-only/bin",
    PG_INSTALL_DIR: "/tmp/devdb-mcp-http-test-only/pg",
    ...env,
  });
  return {
    cfg,
    state: openState(":memory:"),
    engine: { status: () => ({}) } as unknown as EngineRuntime,
    logs: new LogsService(),
    services: {
      projects: {} as unknown as ProjectsService,
      branches: {} as unknown as BranchesService,
      endpoints: {} as unknown as EndpointsService,
      timetravel: {} as unknown as TimeTravelService,
      sql: {} as unknown as SqlService,
    },
  };
}

// Shared shape for the "guard passed, fell through to the session-less 400" assertion used by
// every ALLOWED case below — proves the guard didn't 403 without needing a full hijacked SDK
// handshake through Fastify's inject().
async function expectGuardPassed(app: ReturnType<typeof buildServer>, headers: Record<string, string>) {
  const res = await app.inject({
    method: "POST", url: "/mcp",
    headers: { "content-type": "application/json", ...headers },
    payload: { jsonrpc: "2.0", id: 1, method: "not-initialize" },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: "no valid MCP session — send an initialize request first" });
}

async function expectGuardRejected(app: ReturnType<typeof buildServer>, headers: Record<string, string | string[]>) {
  const res = await app.inject({
    method: "POST", url: "/mcp",
    headers: { "content-type": "application/json", ...headers },
    payload: { jsonrpc: "2.0", id: 1, method: "not-initialize" },
  });
  expect(res.statusCode).toBe(403);
  return res;
}

// Fastify's inject() (light-my-request) can NOT produce a genuinely Host-less request: its
// request builder unconditionally falls back to a synthesized "host: localhost:80" whenever the
// caller's value is falsy (confirmed against light-my-request@6.6.0's lib/request.js:
// `this.headers.host = this.headers.host || options.authority || hostHeaderFromURL(parsedURL)`)
// — so `headers: { host: "" }` still arrives at the guard as a fully-populated, TRUSTED Host.
// A real HTTP/1.0 request (unlike 1.1, HTTP/1.0 does not require a Host header) sent over a raw
// TCP socket against a real listener is the only way to actually exercise the fail-closed-on-
// missing-Host branch — this is exactly the scenario Fix 1's "fail CLOSED on missing Host" bullet
// targets, so it gets real socket-level coverage rather than being skipped as untestable.
function rawHttp10Request(port: number, path: string): Promise<{ statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`POST ${path} HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => resolve({ statusLine: data.split("\r\n")[0] ?? "" }));
    socket.on("error", reject);
  });
}

describe("registerMcp — Host/Origin guard", () => {
  it("allows a trusted loopback hostname even on a port other than the configured httpPort", async () => {
    // Regression coverage for the docker-port-remapping gap: cfg.httpPort is the CONTAINER-
    // INTERNAL port (4400 by default), but a real client (including the Docker-mapped integration
    // test) connects through an arbitrary host-side port testcontainers/compose assigns. An
    // exact "host:port" string allowlist built only from cfg.httpPort would 403 every request
    // that didn't happen to land on port 4400 — this proves the hostname-only match for the
    // well-known loopback names accepts an unrelated port instead.
    await expectGuardPassed(buildServer(fakeDeps()), { host: "localhost:59999" });
  });

  it("rejects an untrusted Host header with 403", async () => {
    const app = buildServer(fakeDeps());
    const res = await expectGuardRejected(app, { host: "evil.example.com" });
    expect(res.json().error).toContain("evil.example.com");
  });

  it("rejects an untrusted Origin header with 403 even when Host is trusted", async () => {
    const app = buildServer(fakeDeps());
    const res = await expectGuardRejected(app, { host: "localhost:4400", origin: "http://evil.example.com" });
    expect(res.json().error).toContain("evil.example.com");
  });

  it("honors DEVDB_MCP_ALLOWED_HOSTS for a non-loopback operator-supplied host", async () => {
    const app = buildServer(fakeDeps({ DEVDB_MCP_ALLOWED_HOSTS: "devdb.internal:4400" }));
    await expectGuardPassed(app, { host: "devdb.internal:4400" });
  });

  it("leaves non-/mcp routes untouched by the guard", async () => {
    const app = buildServer(fakeDeps());
    const res = await app.inject({ method: "GET", url: "/api/status", headers: { host: "evil.example.com" } });
    expect(res.statusCode).toBe(200);
  });

  // --- Fix 1: fail CLOSED on missing/invalid Host ---------------------------------------------

  it("rejects a request with NO Host header at all (fail-closed, not fail-open) — real socket, HTTP/1.0", async () => {
    // See rawHttp10Request's doc comment: inject() cannot produce this condition at all, so this
    // drives a real HTTP/1.0 request (Host is optional in 1.0, unlike 1.1) over a raw TCP socket
    // against a real listener — the guard must 403 a request that has no Host to validate at all,
    // not treat "nothing to check" as "let it through" (that `if (host && !allowed)` fail-open
    // shape is exactly the bug Fix 1 closes).
    const app = buildServer(fakeDeps());
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("expected an AddressInfo");
      const { statusLine } = await rawHttp10Request(address.port, "/mcp");
      expect(statusLine).toContain("403");
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed Host authority (localhost:bad) with 403", async () => {
    const app = buildServer(fakeDeps());
    await expectGuardRejected(app, { host: "localhost:bad" });
  });

  it("rejects a Host that is a join artifact (\"localhost, evil.com\") with 403", async () => {
    const app = buildServer(fakeDeps());
    await expectGuardRejected(app, { host: "localhost, evil.com" });
  });

  // --- Fix 1: reject duplicate/ambiguous Host or Origin (raw-header check) --------------------

  it("rejects a duplicate Host header with 403 even though each individual value is trusted", async () => {
    // Two distinct Host lines on the wire collapse through light-my-request into a single
    // comma-joined rawHeaders value ("localhost,evil.com") — the guard's robust URL-based parse
    // must reject this joined value outright (it is not a valid single hostname), which is
    // exactly the raw-header ambiguity the duplicate-header check exists to catch.
    const app = buildServer(fakeDeps());
    await expectGuardRejected(app, { host: ["localhost", "evil.com"] });
  });

  it("rejects a duplicate Origin header with 403 even when Host is trusted", async () => {
    const app = buildServer(fakeDeps());
    await expectGuardRejected(app, { host: "localhost:4400", origin: ["http://localhost", "http://evil.com"] });
  });

  // --- Fix 1: canonicalization — case, trailing dot, IPv6 --------------------------------------

  it("allows an uppercase Host (LOCALHOST) via case-insensitive canonicalization", async () => {
    const app = buildServer(fakeDeps());
    await expectGuardPassed(app, { host: "LOCALHOST:4400" });
  });

  it("allows a trailing-dot Host (localhost.) via canonicalization", async () => {
    const app = buildServer(fakeDeps());
    await expectGuardPassed(app, { host: "localhost.:4400" });
  });

  it("allows a bracketed IPv6 loopback Host ([::1])", async () => {
    const app = buildServer(fakeDeps());
    await expectGuardPassed(app, { host: "[::1]:4400" });
  });

  // --- Fix 1: Origin present-untrusted vs absent -----------------------------------------------

  it("allows a trusted Host with no Origin header at all (CLI clients send none)", async () => {
    const app = buildServer(fakeDeps());
    await expectGuardPassed(app, { host: "localhost:4400" });
  });
});

describe("registerMcp — session lifecycle plumbing", () => {
  it("400s GET/DELETE /mcp with no mcp-session-id", async () => {
    const app = buildServer(fakeDeps());
    const get = await app.inject({ method: "GET", url: "/mcp", headers: { host: "localhost:4400" } });
    expect(get.statusCode).toBe(400);
    const del = await app.inject({ method: "DELETE", url: "/mcp", headers: { host: "localhost:4400" } });
    expect(del.statusCode).toBe(400);
  });

  it("400s GET/DELETE /mcp with an unknown mcp-session-id", async () => {
    const app = buildServer(fakeDeps());
    const res = await app.inject({
      method: "DELETE", url: "/mcp",
      headers: { host: "localhost:4400", "mcp-session-id": "not-a-real-session" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "unknown or missing mcp-session-id" });
  });
});

// Fix 4: real-listener lifecycle coverage. reply.hijack() hands the raw Node ServerResponse to
// the SDK transport, which streams SSE against it — Fastify's inject() fakes the response object
// and can't carry a real handshake through, so (unlike the guard tests above, which only need to
// prove the guard rejects BEFORE the SDK is ever reached) these drive a real MCP SDK Client
// against a real `app.listen({port:0})` listener, matching the precedent in api.test.ts's SSE
// suite. No Docker needed — this is a loopback TCP listener, not the integration container.
describe("registerMcp — session lifecycle (real listener)", () => {
  async function listening() {
    const app = buildServer(fakeDeps());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("expected an AddressInfo");
    return { app, base: `http://127.0.0.1:${address.port}` };
  }

  it("a real initialize mints exactly one session and returns a session id", async () => {
    const { app, base } = await listening();
    try {
      const client = new Client({ name: "test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
      await client.connect(transport);
      expect(transport.sessionId).toBeDefined();
      expect(typeof transport.sessionId).toBe("string");
      await client.close();
    } finally {
      await app.close();
    }
  });

  it("a follow-up request with the same mcp-session-id resolves to the same session", async () => {
    const { app, base } = await listening();
    try {
      const client = new Client({ name: "test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
      await client.connect(transport);
      const sessionId = transport.sessionId;

      // A second request that reuses the same client/transport (and therefore the same
      // mcp-session-id header the SDK attaches internally) must resolve to the SAME session —
      // proven here by the session id staying stable across a second real RPC round-trip
      // (listTools(), which Task 8 expects to reject with -32601 since no tools are registered
      // yet — the point of this assertion is session continuity, not the tools contract).
      await expect(client.listTools()).rejects.toThrow(/-32601/);
      expect(transport.sessionId).toBe(sessionId);
      await client.close();
    } finally {
      await app.close();
    }
  });

  it("DELETE /mcp tears the session down; a subsequent request with that id is rejected", async () => {
    const { app, base } = await listening();
    try {
      const client = new Client({ name: "test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
      await client.connect(transport);
      const sessionId = transport.sessionId!;
      expect(sessionId).toBeDefined();

      await transport.terminateSession();

      // Same session id, but the store entry is gone — a raw follow-up must be rejected, not
      // silently served. Drive this with a plain fetch() (not the SDK client, which would mint
      // a brand-new session on seeing no active one) so the request is unambiguously "reuse this
      // exact torn-down id."
      const res = await fetch(`${base}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId },
      });
      expect(res.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("app.close() with a live MCP session resolves promptly (closeAll() drains the store, doesn't hang)", async () => {
    // Verified against the SDK client transport's source (client/streamableHttp.js): the
    // CLIENT-side transport's `onclose` only fires from the client's OWN close()/abort — it is
    // NOT wired to fire just because the server-side transport closed the SSE stream out from
    // under it (a server-initiated stream drop instead surfaces as `onerror` with a reconnect
    // attempt). So asserting on the client's onclose here would be asserting on a signal the SDK
    // doesn't actually provide for this scenario — this test instead proves the property that
    // actually matters and IS reliably observable: app.close() (which runs Fastify's preClose
    // hook, where registerMcp's closeAll() is wired — see http/api.ts) resolves promptly with a
    // live session still open. Fix 2 regression coverage: closeAll() awaits
    // Promise.all(...transport.close()...) for every entry — if the onclose/close double-close
    // bug this task fixes ever reappeared (or any future change made a transport's close() hang
    // or throw unswallowed), that would surface here as this test timing out or rejecting, not
    // silently passing. Complements mcp-session.test.ts's direct unit proof that closeAll()
    // closes every entry's transport exactly once and empties the map.
    const { app, base } = await listening();
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
    expect(transport.sessionId).toBeDefined();

    await expect(app.close()).resolves.toBeUndefined();
  });
});
