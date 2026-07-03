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
// this file's very first empty-array default.
interface FakePgQueryResult { rows: unknown[]; rowCount: number | null; fields: { name: string }[] }
const mockConnect = vi.fn(async () => {});
const mockEnd = vi.fn(async () => {});
const mockQuery = vi.fn<(query: string) => Promise<FakePgQueryResult>>(
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

  it("connects to 127.0.0.1:<port> as postgres with the branch's password, 30s statement timeout, 10s connect timeout", async () => {
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints({ port: 54307, password: "hunter2" });
    const sql = new SqlService({ branches, endpoints });

    await sql.run("branch-1", "SELECT 1");

    expect(ClientMock).toHaveBeenCalledWith({
      host: "127.0.0.1", port: 54307, user: "postgres",
      password: "hunter2", database: "postgres",
      statement_timeout: 30_000, connectionTimeoutMillis: 10_000,
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

  it("returns rows/rowCount/fields from a successful query", async () => {
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
    });
  });

  it("caps returned rows at 1000 even when the query returns more", async () => {
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
  // That held for the brief's original single-Client design, but connectWithRetry's corrected,
  // real-pg.Client-compatible implementation (see its own doc comment) DOES call client.end() in
  // its catch block on every failed attempt, retriable or not — a non-auth connect() failure can
  // still leave a partially-open TCP socket (auth happens after transport connects), and pg's own
  // end() is a documented no-op when the connection truly never got underway, so calling it
  // unconditionally here is safe cleanup, not a possibly-erroring extra call against nothing.
  it("ends the client's connection attempt even on a non-retriable connect() failure", async () => {
    mockConnect.mockRejectedValueOnce(new Error("connection refused"));
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    await expect(sql.run("branch-1", "SELECT 1")).rejects.toThrow(/connection refused/);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  // Live-found (this task, running the acceptance test against a real container): CONFIRMED the
  // SAME race tests/integration/helpers/pg.ts's connectWithRetry() already documents from Task 14
  // — compute_ctl matches ComputeManager's readyNeedle ("listening on IPv4 address", the
  // postmaster socket bind) and EndpointsService reports "running" *before* compute_ctl has
  // finished reconciling the SCRAM password/role, so a connect() issued immediately after
  // ensureRunning() resolves can land in that gap and fail with
  // "password authentication failed for user \"postgres\"" even though the password is correct
  // and a retry ~100ms later against a FRESH socket succeeds. pg.ts's helper papers over this for
  // TEST connections; SqlService is PRODUCTION code hit by every POST /api/sql against a
  // just-started endpoint (ensureRunning() is called unconditionally on every request — see its
  // own doc comment) and had no retry at all, so it inherited the exact same race live. Bounded
  // retry (5 attempts x 200ms = up to 1s) ONLY on that specific auth-failure message — any other
  // connect() failure (wrong port, refused, host down) must still surface on the very first
  // attempt with no added latency, since every other failure mode looks identical from here and
  // waiting out the full retry budget on a genuine failure would be a needless multi-second stall
  // on every truly-broken request.
  //
  // Live-found correction (second pass): the FIRST version of this test asserted ClientMock was
  // called exactly once — i.e. that retries reuse one Client instance's .connect(). That passed
  // against the ORIGINAL (too-permissive) mock but failed immediately against a real container,
  // because real pg.Client instances are single-use (see the ClientMock comment above). This
  // version (and the mock it now runs against) both encode the corrected, real-library-verified
  // contract: a FRESH Client per retry attempt, with each failed attempt's client .end()'d before
  // the next attempt's Client is constructed.
  it("retries connect() on the compute_ctl SCRAM-readiness race (password auth failure immediately after start), succeeding once the role settles", async () => {
    mockConnect
      .mockRejectedValueOnce(new Error('password authentication failed for user "postgres"'))
      .mockRejectedValueOnce(new Error('password authentication failed for user "postgres"'))
      .mockResolvedValueOnce(undefined);
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    await sql.run("branch-1", "SELECT 1");

    expect(mockConnect).toHaveBeenCalledTimes(3);
    // A fresh pg.Client per attempt (3 total: 2 failed + 1 successful) — matches real pg.Client's
    // single-use-per-instance contract (see ClientMock's own comment above).
    expect(ClientMock).toHaveBeenCalledTimes(3);
    // Each of the 2 FAILED attempts' clients is .end()'d (cleanup for the auth-failure case, where
    // the TCP socket did open) PLUS the eventually-successful connection's own post-query .end() —
    // 3 total, one per Client instance ever constructed here.
    expect(mockEnd).toHaveBeenCalledTimes(3);
  });

  it("gives up after exhausting retries on a PERSISTENT auth failure and surfaces the auth error", async () => {
    mockConnect.mockRejectedValue(new Error('password authentication failed for user "postgres"'));
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    await expect(sql.run("branch-1", "SELECT 1")).rejects.toThrow(/password authentication failed/);
    expect(mockConnect).toHaveBeenCalledTimes(5);
    expect(ClientMock).toHaveBeenCalledTimes(5); // a fresh Client per attempt, all 5 exhausted
    expect(mockEnd).toHaveBeenCalledTimes(5); // every failed attempt's client is cleaned up
  });

  it("does NOT retry a connect() failure that isn't the auth-race message — surfaces immediately", async () => {
    mockConnect.mockRejectedValueOnce(new Error("connection refused"));
    const branches = fakeBranches();
    const { endpoints } = fakeEndpoints();
    const sql = new SqlService({ branches, endpoints });

    await expect(sql.run("branch-1", "SELECT 1")).rejects.toThrow(/connection refused/);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});
