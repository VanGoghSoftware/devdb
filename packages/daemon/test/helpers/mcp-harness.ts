import { vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../../src/config.js";
import { openState } from "../../src/state/db.js";
import { BranchQueue } from "../../src/state/queue.js";
import { ProjectsService } from "../../src/services/projects.js";
import { BranchesService } from "../../src/services/branches.js";
import { EndpointsService } from "../../src/services/endpoints.js";
import { TimeTravelService } from "../../src/services/timetravel.js";
import { SqlService } from "../../src/services/sql.js";
import { LogsService } from "../../src/services/logs.js";
import { EventsService } from "../../src/services/events.js";
import { registerTools } from "../../src/mcp/tools.js";
import type { ToolCtx } from "../../src/mcp/server.js";
import type { Deps } from "../../src/http/api.js";
import type { EngineRuntime } from "../../src/engine/boot.js";
import type { BuildsResolverApi, ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "../../src/services/engine-api.js";
import type { BuildRegistry } from "../../src/compute/builds/registry.js";
import type { Provisioner } from "../../src/compute/builds/provisioner.js";
import type { Logger } from "../../src/logging/logger.js";
import type { EndpointStatus } from "@devdb/shared";

// buildServer's Deps.engine is typed against the concrete EngineRuntime class, which carries
// private fields (see engine/boot.ts) — same rationale + same narrowly-scoped cast as
// api.test.ts's own fakeEngine(): only `.status()` is ever called by any read tool (get_status).
function fakeEngine(): EngineRuntime {
  return { status: () => ({}) } as unknown as EngineRuntime;
}

function testCfg() {
  return loadConfig({
    DEVDB_DATA_DIR: "/tmp/devdb-mcp-harness-only",
    NEON_BINARIES_DIR: "/tmp/devdb-mcp-harness-only/bin",
    PG_INSTALL_DIR: "/tmp/devdb-mcp-harness-only/pg",
  });
}

// Amendment A2's typed-fakes pattern (see branches-service.test.ts fakes()) — reused here so the
// MCP tool tests exercise the SAME narrow engine-api.ts interfaces the rest of the daemon's unit
// suite fakes, not a bespoke ad-hoc mock. No `as any`/`as never`: every method the interfaces
// declare is present as a vi.fn(), even ones a given test never exercises.
//
// Task 8: `computes` gains `runningPgbin`/`runningPgbins` (tsc-forced by ComputesApi) and `builds`
// joins the bag — production (index.ts) always constructs ProjectsService/BranchesService with a
// real BuildRegistry, so the harness now mirrors that (rather than the pre-Task-8 "no builds dep
// at all" shape) — this is what makes create_project's pgVersion-guard tests exercise the SAME
// reject-unknown-major behavior a real agent hitting the MCP tool would see, not a harness-only
// backward-compat path that diverges from production.
export function fakes(): {
  storcon: StorconApi; pageserver: PageserverApi; safekeeper: SafekeeperApi; computes: ComputesApi;
  builds: BuildsResolverApi; logger: Logger;
} {
  const storcon: StorconApi = {
    tenantCreate: vi.fn(async () => {}),
    getLsnByTimestamp: vi.fn(async () => ({ lsn: "0/0", kind: "present" })),
  };
  const pageserver: PageserverApi = {
    timelineCreate: vi.fn(async () => ({ timeline_id: "x".repeat(32) })),
    timelineInfo: vi.fn(async () => ({
      timeline_id: "x".repeat(32), ancestor_timeline_id: null, ancestor_lsn: "0/1",
      last_record_lsn: "0/2", current_logical_size: 1234,
    })),
    timelineDelete: vi.fn(async () => {}),
    timelineDetachAncestor: vi.fn(async () => ({ reparented_timelines: [] })),
    tenantDelete: vi.fn(async () => {}),
  };
  const safekeeper: SafekeeperApi = {
    timelineDelete: vi.fn(async () => {}),
    tenantDelete: vi.fn(async () => {}),
  };
  const computes: ComputesApi = {
    start: vi.fn(async () => ({ port: 1 })),
    stop: vi.fn(async () => {}),
    statusOf: vi.fn((): EndpointStatus => "stopped"),
    portOf: vi.fn(() => null),
    runningPorts: vi.fn(() => []),
    runningPgbin: vi.fn(() => null),
    runningPgbins: vi.fn(() => []),
    onLine: vi.fn(() => () => {}),
    stopAll: vi.fn(async () => {}),
  };
  // Baked majors today are 14-17 (docker/BINARIES.md) — matches the guard's real-world default so
  // the "accepts 14/15/16/17" MCP tests keep passing unchanged and "accepts 18" now REJECTS.
  const builds: BuildsResolverApi = {
    pgbinFor: vi.fn((major: number) => ({ path: `/usr/local/share/neon/pg_install/v${major}/bin/postgres`, version: `${major}.0`, buildId: `baked-v${major}` })),
    versionForPgbin: vi.fn(() => null),
    recordRun: vi.fn(),
    installedMajors: vi.fn(() => [14, 15, 16, 17]),
  };
  const logger: Logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  return { storcon, pageserver, safekeeper, computes, builds, logger };
}

export interface McpToolsHarness {
  deps: Deps;
  /**
   * The SAME typed engine-api fakes (`storcon`/`pageserver`/`safekeeper`/`computes`/`logger`)
   * wired into every service the harness builds — exposed so a test can reconfigure a mock's
   * return value (e.g. `vi.mocked(engineFakes.computes.statusOf).mockReturnValue("running")`,
   * mirroring branches-service.test.ts's own post-start fixture) or assert a call was made
   * (`engineFakes.computes.start`), without needing a second, divergent set of fakes.
   */
  engineFakes: ReturnType<typeof fakes>;
  /**
   * Calls a registered tool by name through the REAL SDK dispatch path — a real `McpServer` with
   * `registerTools()` applied, connected to a real `Client` over `InMemoryTransport.
   * createLinkedPair()` (the SDK's own same-process client<->server pairing primitive, used
   * exactly the way `tests/integration/mcp-handshake.test.ts` uses a real Client over HTTP, just
   * without the network hop). This exercises the SDK's own arg validation
   * (`validateToolInput`/`normalizeObjectSchema`) and its `tools/call` handler wiring, not a
   * hand-rolled reimplementation of either — so a bug in how `tools.ts` shapes its zod raw shapes
   * would be caught here the same way a real MCP client would hit it.
   */
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Closes the client + server + both linked transports. Call in an `afterEach`/at test end. */
  close(): Promise<void>;
}

export async function makeReadToolsHarness(opts?: {
  /**
   * Overrides the session's captured `clientInfo` (what `ToolCtx.clientInfo()` returns) — the
   * default `{ name: "harness-client", version: "1.0.0" }` is fine for tests that don't care, but
   * create_branch's fork-context-merge test (Task 10) needs to assert a SPECIFIC client identity
   * (e.g. `{ name: "claude-code", version: "9.9" }`) shows up folded into the stored branch
   * context, so it must be settable per-test rather than hardcoded.
   */
  clientInfo?: { name: string; version: string };
}): Promise<McpToolsHarness> {
  const f = fakes();
  const state = openState(":memory:");
  const queue = new BranchQueue();
  const logs = new LogsService();
  const projects = new ProjectsService({ state, queue, ...f });
  const branches = new BranchesService({ state, queue, logs, ...f });
  const endpoints = new EndpointsService({ state, queue, branches, logs, ...f });
  const timetravel = new TimeTravelService({ state, queue, branches, endpoints, ...f });
  const sql = new SqlService({ branches, endpoints });

  // Deps shape matches http/api.ts's Deps interface — the same object the real /mcp session
  // wiring (mcp/http.ts -> buildMcpServer) constructs a ToolCtx from, so registerTools sees an
  // identical dependency surface in tests as in production.
  const deps: Deps = {
    cfg: testCfg(),
    state,
    engine: fakeEngine(),
    logs,
    events: new EventsService(),
    // Fix 1 (task-9 fix wave): the same typed fake Logger from fakes() — so mcp-tools.test.ts can
    // assert guard() actually logged a non-DevdbError failure through THIS instance, not just that
    // some logger somewhere was called.
    logger: f.logger,
    // Task 10 (dynamic-pg-builds): registry/provisioner/computes are now required on Deps — no
    // MCP read tool this harness drives touches a pg-builds route (those are REST-only per this
    // task's brief; MCP pg-builds tool coverage, if any, is Task 11's job), so bare stand-ins are
    // enough here. `computes` reuses the SAME typed ComputesApi fake (`f.computes`) already wired
    // into every service above, rather than a second divergent one.
    registry: { list: vi.fn(() => []), installedMajors: vi.fn(() => []), degradedMajors: vi.fn(() => []) } as unknown as BuildRegistry,
    provisioner: { updateAvailableFor: vi.fn(() => null) } as unknown as Provisioner,
    computes: f.computes,
    services: { projects, branches, endpoints, timetravel, sql },
  };

  const server = new McpServer({ name: "devdb-test", version: "0.0.0-test" });
  const resolvedClientInfo = opts?.clientInfo ?? { name: "harness-client", version: "1.0.0" };
  const clientInfo: ToolCtx["clientInfo"] = () => resolvedClientInfo;
  registerTools(server, { deps, clientInfo });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-harness-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    deps,
    engineFakes: f,
    async call(name, args) {
      // callTool()'s declared return type is a union of CallToolResult (content: [...]) and the
      // experimental task-based {toolResult: ...} shape (only reachable by passing a `task` param
      // this harness never sets) — narrowing to CallToolResult here is a legitimate "pick the
      // branch that's always true given the args passed", not a type-safety bypass: no read tool
      // uses task-based execution (see tools.ts's execution/taskSupport is never set), so this
      // call always resolves the plain CallToolResult branch at runtime.
      return client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
