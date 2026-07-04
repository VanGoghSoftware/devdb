import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildServer, type Deps } from "../src/http/api.js";
import { loadConfig, type DevdbConfig } from "../src/config.js";
import { openState } from "../src/state/db.js";
import type { EngineRuntime } from "../src/engine/boot.js";
import type { ProjectsService } from "../src/services/projects.js";
import type { BranchesService } from "../src/services/branches.js";
import type { EndpointsService } from "../src/services/endpoints.js";
import type { TimeTravelService } from "../src/services/timetravel.js";
import type { SqlService } from "../src/services/sql.js";
import { LogsService } from "../src/services/logs.js";
import { EventsService } from "../src/services/events.js";

// Same fake-Deps recipe as test/api.test.ts / test/mcp-http.test.ts (fakeEngine/fakeProjects/etc.
// pattern) — only `cfg` varies per test here (that's the whole point of this file), so the
// service fakes are vi.fn() stand-ins never actually invoked by the routes under test: every
// request below either hits the static/SPA-fallback path or an early guard/404, never real
// service logic.
function fakeCfg(overrides: Partial<DevdbConfig> = {}): DevdbConfig {
  const cfg = loadConfig({
    DEVDB_DATA_DIR: "/tmp/devdb-static-test-only",
    NEON_BINARIES_DIR: "/tmp/devdb-static-test-only/bin",
    PG_INSTALL_DIR: "/tmp/devdb-static-test-only/pg",
  });
  return { ...cfg, ...overrides };
}

function fakeDeps(overrides: { cfg: DevdbConfig }): Deps {
  return {
    cfg: overrides.cfg,
    state: openState(":memory:"),
    engine: { status: () => ({}) } as unknown as EngineRuntime,
    logs: new LogsService(),
    events: new EventsService(),
    services: {
      projects: { create: vi.fn(), list: vi.fn(), byIdOr404: vi.fn(), delete: vi.fn() } as unknown as ProjectsService,
      branches: {
        create: vi.fn(), list: vi.fn(), byIdOr404: vi.fn(), delete: vi.fn(),
        detail: vi.fn(), connectionString: vi.fn(), rename: vi.fn(),
      } as unknown as BranchesService,
      endpoints: { start: vi.fn(), stop: vi.fn(), ensureRunning: vi.fn() } as unknown as EndpointsService,
      timetravel: {
        lsnAtTimestamp: vi.fn(), branchAtTimestamp: vi.fn(), restoreInPlace: vi.fn(), resetToParent: vi.fn(),
      } as unknown as TimeTravelService,
      sql: { run: vi.fn() } as unknown as SqlService,
    },
  };
}

function makeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "devdb-webdist-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><div id=\"root\">devdb-app</div>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

describe("web UI static serving + SPA fallback", () => {
  it("serves index.html at /, real assets at their path, and index.html for SPA deep links", async () => {
    const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
    expect((await app.inject({ url: "/" })).body).toContain("devdb-app");
    expect((await app.inject({ url: "/assets/app.js" })).statusCode).toBe(200);
    const deep = await app.inject({ url: "/projects/abc123?branch=b1" });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("devdb-app");
  });

  it("NEVER swallows /api or /mcp: unknown API routes stay JSON 404; POST is never index.html", async () => {
    const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
    const apiMiss = await app.inject({ url: "/api/nope" });
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.headers["content-type"]).toContain("application/json");
    const postMiss = await app.inject({ method: "POST", url: "/definitely/not/a/route" });
    expect(postMiss.statusCode).toBe(404);
    const mcpGet = await app.inject({ url: "/mcp", headers: { host: "evil.example" } });
    expect(mcpGet.body).not.toContain("devdb-app"); // guard's own response, not the SPA
  });

  it("with webDistDir null the app behaves exactly as before (no static routes)", async () => {
    const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: null }) }));
    expect((await app.inject({ url: "/" })).statusCode).toBe(404);
  });

  it("with webDistDir pointing at a missing directory, boot does not crash and UI is skipped", async () => {
    const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: "/nonexistent/webdist" }) }));
    expect((await app.inject({ url: "/" })).statusCode).toBe(404);
  });
});
