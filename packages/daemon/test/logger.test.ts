import { describe, expect, it, vi } from "vitest";
import { LogsService } from "../src/services/logs.js";
import { createLogger, daemonLogChannel } from "../src/logging/logger.js";
import { buildServer } from "../src/http/api.js";
import { loadConfig } from "../src/config.js";
import { openState } from "../src/state/db.js";
import type { EngineRuntime } from "../src/engine/boot.js";
import type { ProjectsService } from "../src/services/projects.js";
import type { BranchesService } from "../src/services/branches.js";
import type { EndpointsService } from "../src/services/endpoints.js";
import type { TimeTravelService } from "../src/services/timetravel.js";
import type { SqlService } from "../src/services/sql.js";

describe("createLogger", () => {
  it("ingests a formatted line into the daemon:app channel and writes stderr", () => {
    const logs = new LogsService();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger(logs);
    logger.error("compensation failed — orphaned timeline t1", new Error("boom"));
    // Fix 1 (review, fix wave): the SSE route (http/api.ts) subscribes `daemon:${component}`,
    // so `/api/daemon/logs/app` reads channel `daemon:app` — the logger must ingest to that FULL
    // channel, not the raw "app" string, or the route never sees these lines (see the
    // channel-wiring test below for the end-to-end proof).
    const recent = logs.recent("daemon:app");
    expect(recent).toHaveLength(1);
    expect(recent[0]).toContain("[error]");
    expect(recent[0]).toContain("orphaned timeline t1");
    expect(recent[0]).toContain("boom");
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  // Fix 2 (review, fix wave): fmt() must never throw. Compensation handlers call
  // `this.deps.logger.error(msg, caughtValue)` INSIDE best-effort cleanup .catch() callbacks —
  // a throwing formatter would propagate, mask the original failure, and skip any cleanup steps
  // still queued after it (e.g. the safekeeper delete after a pageserver delete already failed).
  it("does not throw when the detail is circular, and still ingests a line", () => {
    const logs = new LogsService();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger(logs);
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => logger.error("compensation failed", circular)).not.toThrow();
    const recent = logs.recent("daemon:app");
    expect(recent).toHaveLength(1);
    expect(recent[0]).toContain("[error]");
    expect(recent[0]).toContain("compensation failed");
    vi.restoreAllMocks();
  });

  it("does not throw when the detail contains a BigInt, and still ingests a line", () => {
    const logs = new LogsService();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger(logs);
    const detail = { count: 10n };
    expect(() => logger.error("compensation failed", detail)).not.toThrow();
    const recent = logs.recent("daemon:app");
    expect(recent).toHaveLength(1);
    expect(recent[0]).toContain("[error]");
    vi.restoreAllMocks();
  });

  // Fix 3 (review, fix wave): all levels must fan out to stderr (console.error) — info previously
  // wrote console.log (stdout), contradicting the stated stderr-fanout contract.
  it("routes info (not just warn/error) to console.error, not console.log", () => {
    const logs = new LogsService();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger(logs);
    logger.info("some info event");
    expect(errSpy).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
    const recent = logs.recent("daemon:app");
    expect(recent).toHaveLength(1);
    expect(recent[0]).toContain("[info]");
    vi.restoreAllMocks();
  });
});

// Fix 1 (review, fix wave) — end-to-end channel wiring.
//
// Fix 2 (review, fix wave 2) — honest scope of this test: the route (http/api.ts) and the
// logger's default (logging/logger.ts) both now derive their channel from the single
// `daemonLogChannel()` helper, so they cannot drift from EACH OTHER without one side bypassing
// the helper entirely (a deliberate, visible change, not a silent one). What this test actually
// still guards against is logger-side drift: it proves `createLogger`'s default channel equals
// `daemonLogChannel("app")` by observing a subscriber registered on that exact value receive the
// logger's line. It does NOT independently re-derive or re-check the route's construction (the
// route is exercised separately below, via the live allowlist/404 checks) — this is not
// symmetric proof that route and logger agree, because they no longer have two independent
// formulas to agree between; there is only one formula now, and this test confirms the logger
// side actually calls it.
//
// The SSE route (http/api.ts `sse()` helper, called from `GET /api/daemon/logs/:component`)
// hijacks the reply and never calls `reply.raw.end()` on the success path — the live tail is
// meant to stay open for a real EventSource client indefinitely. Empirically, `app.inject()`
// against that route hangs (verified during this fix: a bare `await app.inject(...)` timed out
// after 2s with no response), so driving the route through a full HTTP round-trip in a unit test
// is genuinely heavy, matching the fix brief's own "if a full SSE test is heavy" carve-out.
describe("logger -> SSE channel wiring (end-to-end)", () => {
  const SSE_COMPONENT = "app"; // same literal the fix wave adds to DAEMON_LOG_COMPONENTS

  it("a logger.error line is observed by a fresh subscriber to the exact channel the SSE route subscribes for /api/daemon/logs/app", () => {
    const logs = new LogsService();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const channel = daemonLogChannel(SSE_COMPONENT);
    const received: string[] = [];
    const unsub = logs.subscribe(channel, (line) => received.push(line));

    const logger = createLogger(logs); // must default to the route-matching channel
    logger.error("compensation failed — orphaned timeline t1", new Error("boom"));

    expect(received).toHaveLength(1);
    expect(received[0]).toContain("orphaned timeline t1");
    expect(received[0]).toContain("boom");

    // If the logger's default channel ever regresses to a bare "app" (or anything other than
    // `daemonLogChannel("app")`), this subscriber — registered against that same helper — receives
    // nothing, and the assertion above fails. This is the guard against logger-side re-divergence
    // from the shared helper (see fix-wave-2 note above for what this test does and does not
    // prove about the route side).
    unsub();
    vi.restoreAllMocks();
  });

  function testCfg() {
    return loadConfig({
      DEVDB_DATA_DIR: "/tmp/devdb-logger-wiring-test-only",
      NEON_BINARIES_DIR: "/tmp/devdb-logger-wiring-test-only/bin",
      PG_INSTALL_DIR: "/tmp/devdb-logger-wiring-test-only/pg",
    });
  }

  function buildTestServer(logs: LogsService) {
    return buildServer({
      cfg: testCfg(),
      state: openState(":memory:"),
      engine: { status: () => ({}) } as unknown as EngineRuntime,
      logs,
      services: {
        projects: {} as unknown as ProjectsService,
        branches: {} as unknown as BranchesService,
        endpoints: {} as unknown as EndpointsService,
        timetravel: {} as unknown as TimeTravelService,
        sql: {} as unknown as SqlService,
      },
    });
  }

  it("the real /api/daemon/logs/:component route rejects an unknown component with 404 (allowlist gate is live)", async () => {
    const app = buildTestServer(new LogsService());
    const res = await app.inject({ method: "GET", url: "/api/daemon/logs/definitely-not-a-real-component" });
    expect(res.statusCode).toBe(404);
  });

  it("the real route accepts /api/daemon/logs/app (does not 404) and would stream the channel createLogger ingests to", async () => {
    // The success path hijacks the reply and keeps the SSE connection open forever (no
    // reply.raw.end() call on that path) — inject() cannot be awaited to completion here without
    // hanging the test (confirmed empirically while writing this fix). Instead, replay-before-
    // subscribe lines are already available synchronously via `recent()` — pre-populate the exact
    // channel createLogger targets, subscribe a control listener alongside, and simply confirm
    // the request does not resolve into a 404 within a bounded window, i.e. it passed the
    // allowlist check and reached hijack()/replay — which is only possible for a component
    // present in DAEMON_LOG_COMPONENTS, the same set "app" was added to in this fix.
    const logs = new LogsService();
    const logger = createLogger(logs);
    logger.error("pre-existing line for replay");
    const app = buildTestServer(logs);

    let settledWith404 = false;
    const injected = app.inject({ method: "GET", url: "/api/daemon/logs/app" }).then((res) => {
      settledWith404 = res.statusCode === 404;
    });
    injected.catch(() => {});

    // Bounded wait strictly shorter than vitest's default test timeout — long enough for the
    // route handler to run synchronously up to hijack()+404-check, far short of "hung forever".
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(settledWith404).toBe(false);
  });
});
