import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchesService } from "../src/services/branches.js";
import type { EndpointsService } from "../src/services/endpoints.js";
import { DevdbError } from "../src/services/errors.js";

// Mocking note (Task 17, per the brief's explicit judgment call — "mock the pg Client via
// vi.mock or a small injected factory"): SqlService's constructor signature is fixed by the brief
// to `{ branches: BranchesService; endpoints: EndpointsService }` — there is no third constructor
// arg to inject a pg-client factory through, and the brief's own sql.ts snippet does
// `new pg.Client(...)` directly. Rather than widen the brief's constructor shape just to make pg
// injectable, this mocks the "pg" module itself via vi.mock — the SAME idiom this codebase already
// uses for its own process-boundary modules (manager.test.ts and boot.test.ts both
// vi.mock("../src/engine/process.js", ...) / vi.mock("../src/engine/embedded-postgres.js", ...)
// rather than exercise a real child process in a unit test). pg's Client is exactly that kind of
// boundary — a real TCP/SCRAM handshake against a live postgres — so treating it the same way (a
// vi.mock'd module boundary, not a constructor-injected fake) keeps this test file's dependency
// story consistent with the rest of the suite rather than introducing a second, bespoke pattern
// for one module. The mock factory's shape (`default: { Client: ... }`) mirrors exactly how the
// SUT imports it (`import pg from "pg"` — a default import of the CJS module, matching the
// brief's own sql.ts snippet), so a shape mismatch here would fail loudly as a TypeScript error
// rather than silently miss the real import site.
// Typed explicitly (rather than inferred from the factory's own initial-value literal) so that
// later mockResolvedValueOnce()/mockRejectedValueOnce() calls with differently-shaped row objects
// (e.g. { id, name } vs. { n }) aren't rejected against a `never[]`/literal type narrowed from
// this file's very first empty-array default. The return type also accepts an array (for multi-statement queries).
interface FakePgQueryResult { rows: unknown[]; rowCount: number | null; fields: { name: string }[] }
type FakePgQueryReturnType = FakePgQueryResult | FakePgQueryResult[];
const mockConnect = vi.fn(async () => {});
const mockEnd = vi.fn(async () => {});
const mockQuery = vi.fn<(query: string) => Promise<FakePgQueryReturnType>>(
  async () => ({ rows: [], rowCount: 0, fields: [] }),
);
// Live-found (this task): real pg.Client instances are single-use — a SECOND .connect() call on
// the same instance throws "Client has already been connected. You cannot reuse a client."
// (confirmed against pg's own client.js source, and empirically against a real acceptance-test
// run). The very first version of this mock didn't enforce that constraint, which let a design
// bug (retrying via repeated .connect() calls on ONE shared client) pass every unit test here
// while failing immediately against the real library. This per-instance connect-call counter
// closes that gap so this mock can never again silently tolerate a design that violates it.
let connectCallsOnThisInstance = 0;
const ClientMock = vi.fn(() => {
  connectCallsOnThisInstance = 0;
  return {
    connect: async () => {
      connectCallsOnThisInstance++;
      if (connectCallsOnThisInstance > 1) {
        throw new Error("Client has already been connected. You cannot reuse a client.");
      }
      return mockConnect();
    },
    end: mockEnd,
    query: mockQuery,
  };
});
vi.mock("pg", () => ({
  default: { Client: ClientMock },
}));

const { SqlService } = await import("../src/services/sql.js");

// Same rationale as api.test.ts's fakeBranches()/fakeEndpoints(): SqlService's constructor is
// typed against the CONCRETE BranchesService/EndpointsService classes (not the narrow engine-api.ts
// interfaces, which back a different dependency shape — ProjectsDeps), so a plain fake needs the
// same narrowly-scoped cast api.test.ts already establishes for these two classes.
function fakeBranches(): BranchesService {
  return { byIdOr404: vi.fn() } as unknown as BranchesService;
}

function fakeEndpoints(overrides: Partial<Awaited<ReturnType<EndpointsService["ensureRunning"]>>> = {}) {
  const detail = {
    id: "branch-1", name: "main", port: 54300, password: "s3cr3t-pw",
    connectionString: "postgresql://postgres:s3cr3t-pw@localhost:54300/postgres",
    ...overrides,
  };
  const endpoints = {
    ensureRunning: vi.fn(async () => detail),
  } as unknown as EndpointsService;
  return { endpoints, detail };
}

describe("SqlService", () => {
  beforeEach(() => {
    ClientMock.mockClear();
    mockConnect.mockClear();
    mockEnd.mockClear();
    mockQuery.mockClear();
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, fields: [] });
  });

  it("rejects an empty query with 400 before ever calling ensureRunning", async () => {
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    await expect(sql.run("branch-1", "   ")).rejects.toMatchObject({ statusCode: 400 });
    expect(endpoints.ensureRunning).not.toHaveBeenCalled();
    expect(ClientMock).not.toHaveBeenCalled();
  });

  it("rejects a fully empty string the same way", async () => {
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    await expect(sql.run("branch-1", "")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("calls ensureRunning for the branch — safe/idempotent to call per SQL request even when already running", async () => {
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    await sql.run("branch-1", "SELECT 1");

    expect(endpoints.ensureRunning).toHaveBeenCalledWith("branch-1");
  });

  it("connects to 127.0.0.1:<port> as postgres with the branch's password, 30s statement timeout, 35s query timeout, 10s connect timeout", async () => {
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints({ port: 54307, password: "hunter2" });
    const sql = new SqlService({ branches, endpoints });

    await sql.run("branch-1", "SELECT 1");

    expect(ClientMock).toHaveBeenCalledWith({
      host: "127.0.0.1", port: 54307, user: "postgres",
      password: "hunter2", database: "postgres",
      statement_timeout: 30_000,
      query_timeout: 35_000,
      connectionTimeoutMillis: 10_000,
    });
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("502s when ensureRunning resolves without a live connectionString/port (endpoint didn't come up)", async () => {
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints({ port: null, connectionString: null });
    const sql = new SqlService({ branches, endpoints });

    await expect(sql.run("branch-1", "SELECT 1")).rejects.toMatchObject({ statusCode: 502 });
    expect(ClientMock).not.toHaveBeenCalled();
  });

  it("returns rows/rowCount/fields/truncated from a successful query", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }],
      rowCount: 2,
      fields: [{ name: "id" }, { name: "name" }],
    });
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    const out = await sql.run("branch-1", "SELECT * FROM t");

    expect(out).toEqual({
      rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }],
      rowCount: 2,
      fields: ["id", "name"],
      truncated: false,
    });
  });

  it("caps returned rows at 1000 even when the query returns more, and sets truncated flag", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ n: i }));
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 1500, fields: [{ name: "n" }] });
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    const out = await sql.run("branch-1", "SELECT * FROM big_table");

    expect(out.rows).toHaveLength(1000);
    expect(out.rows[0]).toEqual({ n: 0 });
    expect(out.rows[999]).toEqual({ n: 999 });
    // rowCount reports the query's TRUE count (1500), not the capped rows.length — the cap is a
    // response-size guard, not a lie about how many rows actually matched.
    expect(out.rowCount).toBe(1500);
    expect(out.truncated).toBe(true);
  });

  it("falls back rowCount to the (possibly capped) rows.length when the driver reports rowCount as null", async () => {
    const rows = [{ n: 1 }, { n: 2 }];
    mockQuery.mockResolvedValueOnce({ rows, rowCount: null, fields: [{ name: "n" }] });
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    const out = await sql.run("branch-1", "CREATE TABLE t (n int)");

    expect(out.rowCount).toBe(2);
  });

  it("handles multi-statement queries by reporting the last result with rows (psql convention)", async () => {
    // Simple-query protocol returns an ARRAY of results for multi-statement strings.
    mockQuery.mockResolvedValueOnce([
      { rows: [], rowCount: 0, fields: [] }, // CREATE TABLE result (no rows)
      { rows: [{ id: 1 }, { id: 2 }], rowCount: 2, fields: [{ name: "id" }] }, // SELECT result
    ]);
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    const out = await sql.run("branch-1", "CREATE TABLE t (id int); SELECT * FROM t");

    expect(out.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(out.rowCount).toBe(2);
    expect(out.fields).toEqual(["id"]);
    expect(out.truncated).toBe(false);
  });

  it("always ends the client connection, even when the query throws", async () => {
    mockQuery.mockRejectedValueOnce(new Error("syntax error at or near"));
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    await expect(sql.run("branch-1", "SELEKT 1")).rejects.toThrow(/syntax error/);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it("propagates a query error rather than swallowing it", async () => {
    mockQuery.mockRejectedValueOnce(new Error("relation \"nope\" does not exist"));
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    await expect(sql.run("branch-1", "SELECT * FROM nope")).rejects.toThrow(/does not exist/);
  });

  // Live-found correction: the first version of this test asserted end() is NOT called on a
  // connect() failure (reasoning: the brief's snippet wraps only client.query() in try/finally).
  // That held for the brief's original single-Client design, but sql.ts's connect() is now wrapped
  // in its OWN try/catch (Task 5, replacing connectWithRetry — see the doc comment above the
  // client construction) that calls client.end() on any connect() failure — a non-auth connect()
  // failure can still leave a partially-open TCP socket (auth happens after transport connects),
  // and pg's own end() is a documented no-op when the connection truly never got underway, so
  // calling it unconditionally here is safe cleanup, not a possibly-erroring extra call against
  // nothing.
  it("ends the client's connection attempt even on a connect() failure", async () => {
    mockConnect.mockRejectedValueOnce(new Error("connection refused"));
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    await expect(sql.run("branch-1", "SELECT 1")).rejects.toThrow(/connection refused/);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  // Task 5: this file used to carry two tests here asserting connectWithRetry()'s bounded-retry
  // behavior on "password authentication failed" — that behavior is GONE. The race it papered
  // over (compute_ctl's readyNeedle firing before apply_spec committed the branch's first-ever
  // SCRAM verifier) is now closed structurally: ComputeManager.start() blocks on
  // waitComputeReady() polling compute_ctl_up{status="running"} (set strictly after apply_spec
  // commits — handover §4.3; compute/readiness.ts) before EndpointsService/ensureRunning() ever
  // reports the endpoint "running". So SqlService has no retry logic left to test — the two tests
  // below prove the replacement invariant instead: exactly ONE connect() attempt, whatever the
  // failure, with the partially-open socket still cleaned up via end().
  it("surfaces a connect() auth failure on the FIRST attempt — no retry left to mask it (readiness gate replaces it)", async () => {
    mockConnect.mockRejectedValueOnce(new Error('password authentication failed for user "postgres"'));
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    await expect(sql.run("branch-1", "SELECT 1")).rejects.toThrow(/password authentication failed/);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(ClientMock).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledTimes(1); // cleanup for the auth-failure case (TCP socket did open)
  });

  it("does not retry a connect() failure that isn't auth-shaped either — surfaces immediately", async () => {
    mockConnect.mockRejectedValueOnce(new Error("connection refused"));
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    await expect(sql.run("branch-1", "SELECT 1")).rejects.toThrow(/connection refused/);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  // ——— Fix 2 (task-9 gate integration): noAutoStart mode ———
  // The default path's ensureRunning shares startLocked's crash recovery, which restarts a FAILED
  // compute with the currently-ACTIVE build's pgbin — for POST /api/sql that recovery is the
  // feature, but the validation gate's smoke SQL would silently run against the WRONG build if
  // the candidate crashed after startWithPgbin. noAutoStart reads the endpoint's CURRENT state
  // via branches.detail (connectionString/port non-null only while actually running) and hard-502s
  // instead of starting anything.
  describe("noAutoStart (validation-gate mode)", () => {
    // Only name/port/connectionString/password are consumed by run(); byIdOr404's row only feeds
    // detail(). Same narrowly-scoped cast idiom as fakeBranches()/fakeEndpoints() above.
    function fakeBranchesWithDetail(a: { running: boolean; port?: number; password?: string }) {
      const port = a.port ?? 54311;
      const detail = {
        id: "branch-1", name: "main", password: a.password ?? "gate-pw",
        port: a.running ? port : null,
        connectionString: a.running ? `postgresql://postgres:pw@localhost:${port}/postgres` : null,
      };
      const byIdOr404 = vi.fn((id: string) => ({ id, name: "main" }));
      const detailSpy = vi.fn(async () => detail);
      const branches = { byIdOr404, detail: detailSpy } as unknown as BranchesService;
      return { branches, byIdOr404, detailSpy };
    }

    it("never calls ensureRunning; a non-running endpoint is a hard 502 and no client is ever constructed", async () => {
      const { branches, byIdOr404, detailSpy } = fakeBranchesWithDetail({ running: false });
      const { endpoints } = fakeEndpoints();
      const sql = new SqlService({ branches, endpoints });

      await expect(sql.run("branch-1", "SELECT version()", { noAutoStart: true }))
        .rejects.toMatchObject({ statusCode: 502 });
      expect(endpoints.ensureRunning).not.toHaveBeenCalled();
      expect(byIdOr404).toHaveBeenCalledWith("branch-1");
      expect(detailSpy).toHaveBeenCalledTimes(1);
      expect(ClientMock).not.toHaveBeenCalled();
    });

    it("queries the CURRENT endpoint when it is running — still without ensureRunning", async () => {
      const { branches } = fakeBranchesWithDetail({ running: true, port: 54322, password: "gate-pw" });
      const { endpoints } = fakeEndpoints();
      const sql = new SqlService({ branches, endpoints });
      mockQuery.mockResolvedValueOnce({ rows: [{ v: 1 }], rowCount: 1, fields: [{ name: "v" }] });

      const out = await sql.run("branch-1", "SELECT 1 AS v", { noAutoStart: true });

      expect(out.rows).toEqual([{ v: 1 }]);
      expect(endpoints.ensureRunning).not.toHaveBeenCalled();
      expect(ClientMock).toHaveBeenCalledWith(expect.objectContaining({ port: 54322, password: "gate-pw" }));
    });

    it("the default path (no opts) keeps auto-starting via ensureRunning — POST /api/sql behavior unchanged", async () => {
      const { branches, byIdOr404, detailSpy } = fakeBranchesWithDetail({ running: false });
      const { endpoints } = fakeEndpoints();
      const sql = new SqlService({ branches, endpoints });

      await sql.run("branch-1", "SELECT 1");

      expect(endpoints.ensureRunning).toHaveBeenCalledWith("branch-1");
      expect(byIdOr404).not.toHaveBeenCalled();
      expect(detailSpy).not.toHaveBeenCalled();
    });
  });
});
