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
import type { BuildRegistry } from "../src/compute/builds/registry.js";
import type { Provisioner } from "../src/compute/builds/provisioner.js";
import type { ComputesApi } from "../src/services/engine-api.js";

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
    // Task 10 (dynamic-pg-builds): registry/provisioner/computes are now required on Deps — this
    // file's routes under test never touch a pg-builds route (static/SPA-fallback and early-guard
    // paths only), so bare vi.fn() stand-ins are enough, same rationale as the service fakes below.
    registry: { list: vi.fn(() => []), installedMajors: vi.fn(() => []), degradedMajors: vi.fn(() => []) } as unknown as BuildRegistry,
    provisioner: { updateAvailableFor: vi.fn(() => null) } as unknown as Provisioner,
    computes: { runningPgbins: vi.fn(() => []) } as unknown as ComputesApi,
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
  // Fixture for Fix 1: a file that would (if served) prove the static plugin itself must also
  // reject reserved paths via allowedPath, independent of the notFoundHandler.
  mkdirSync(join(dir, "api"));
  writeFileSync(join(dir, "api", "nope"), "should never be served");
  // Fixture for Fix 3: a dotfile that must never be served regardless of dotfiles default.
  writeFileSync(join(dir, ".secret"), "sensitive");
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

  // Fix 1 (P2): the reserved-prefix check must normalize the raw URL (strip query string, decode
  // percent-encoding) before testing for /api or /mcp — otherwise query strings and encoding
  // trivially defeat the guard and leak the SPA's index.html where a JSON 404 is contracted.
  describe("Fix 1: reserved-prefix guard is robust to query strings + percent-encoding", () => {
    it("GET /api?x=1 (query string defeats naive `=== \"/api\"` check) stays a JSON 404", async () => {
      const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
      const res = await app.inject({ url: "/api?x=1" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body).not.toContain("devdb-app");
    });

    it("GET /%61pi/nope (percent-encoded 'api') stays a JSON 404, not index.html", async () => {
      const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
      const res = await app.inject({ url: "/%61pi/nope" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body).not.toContain("devdb-app");
    });

    it("GET /m%63p/deep (percent-encoded 'mcp') stays a JSON 404, not index.html", async () => {
      const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
      const res = await app.inject({ url: "/m%63p/deep" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body).not.toContain("devdb-app");
    });

    it("a real dist/api/nope file is never served — allowedPath rejects it at the static-plugin layer", async () => {
      const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
      const res = await app.inject({ url: "/api/nope" });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("should never be served");
    });
  });

  // Fix 2 (P3): the SPA fallback must only fire for extensionless app routes. A missing static
  // asset (e.g. a stale /assets/x.js reference from a broken build) must 404 for real instead of
  // silently returning a 200 HTML document that then fails to parse as JS in the browser.
  describe("Fix 2: SPA fallback is extension-aware", () => {
    it("GET /assets/missing-file.js (has an extension, does not exist) is a real 404, not index.html", async () => {
      const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
      const res = await app.inject({ url: "/assets/missing-file.js" });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("devdb-app");
    });

    it("GET /projects/some-id (extensionless SPA route) still returns index.html 200", async () => {
      const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
      const res = await app.inject({ url: "/projects/some-id" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("devdb-app");
    });
  });

  // Fix 3 (P4): @fastify/static v9 defaults dotfiles to "allow" — hidden files under a
  // (possibly mispointed) DEVDB_WEB_DIST must never be served.
  describe("Fix 3: dotfiles are denied", () => {
    it("GET /.secret is not served", async () => {
      const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
      const res = await app.inject({ url: "/.secret" });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("sensitive");
    });
  });

  // Fix 5 (P4): with the UI mounted, the explicit routes and cross-cutting guards registered
  // BEFORE registerWebUi must still win over the static wildcard + SPA fallback.
  describe("Fix 5: guarded contracts still hold with the UI mounted", () => {
    it("GET /api/status still returns its real status JSON payload (explicit route beats the wildcard+fallback)", async () => {
      const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
      const res = await app.inject({ url: "/api/status" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      const body = res.json() as Record<string, unknown>;
      expect(body).toHaveProperty("version");
    });

    it("GET /mcp with an untrusted Host still 403s via the rebinding guard (not index.html, not 200)", async () => {
      const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
      const res = await app.inject({ url: "/mcp", headers: { host: "evil.example" } });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain("devdb-app");
    });
  });
});
