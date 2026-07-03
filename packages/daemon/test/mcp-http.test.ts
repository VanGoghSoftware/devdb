import { describe, expect, it } from "vitest";
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

describe("registerMcp — Host/Origin guard", () => {
  it("allows a trusted loopback hostname even on a port other than the configured httpPort", async () => {
    // Regression coverage for the docker-port-remapping gap: cfg.httpPort is the CONTAINER-
    // INTERNAL port (4400 by default), but a real client (including the Docker-mapped integration
    // test) connects through an arbitrary host-side port testcontainers/compose assigns. An
    // exact "host:port" string allowlist built only from cfg.httpPort would 403 every request
    // that didn't happen to land on port 4400 — this proves the hostname-only match for the
    // well-known loopback names accepts an unrelated port instead.
    const app = buildServer(fakeDeps());
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { host: "localhost:59999", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "not-initialize" },
    });
    // Guard passed (no 403); falls through to the "send an initialize request first" 400 since
    // this isn't a real initialize payload — proves the guard didn't reject it, without needing
    // to drive a full hijacked SDK handshake through Fastify's inject().
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "no valid MCP session — send an initialize request first" });
  });

  it("rejects an untrusted Host header with 403", async () => {
    const app = buildServer(fakeDeps());
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { host: "evil.example.com", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "not-initialize" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("evil.example.com");
  });

  it("rejects an untrusted Origin header with 403 even when Host is trusted", async () => {
    const app = buildServer(fakeDeps());
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { host: "localhost:4400", origin: "http://evil.example.com", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "not-initialize" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("evil.example.com");
  });

  it("honors DEVDB_MCP_ALLOWED_HOSTS for a non-loopback operator-supplied host", async () => {
    const app = buildServer(fakeDeps({ DEVDB_MCP_ALLOWED_HOSTS: "devdb.internal:4400" }));
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { host: "devdb.internal:4400", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "not-initialize" },
    });
    expect(res.statusCode).toBe(400); // guard passed; falls through to the same session-less 400
  });

  it("leaves non-/mcp routes untouched by the guard", async () => {
    const app = buildServer(fakeDeps());
    const res = await app.inject({ method: "GET", url: "/api/status", headers: { host: "evil.example.com" } });
    expect(res.statusCode).toBe(200);
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
