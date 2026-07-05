import pg from "pg";
import { DevdbError } from "./errors.js";
import type { BranchesService } from "./branches.js";
import type { EndpointsService } from "./endpoints.js";

// Task 5: connectWithRetry() (bounded retry on "password authentication failed") used to paper
// over a real race — compute_ctl's readyNeedle ("listening on IPv4 address") fired before
// apply_spec had committed the branch's first-ever SCRAM verifier, so a connect() issued right
// after ensureRunning() resolved could land in that gap. That gap is now closed structurally:
// EndpointsService's start path (via ComputeManager.start()) blocks on waitComputeReady() polling
// compute_ctl_up{status="running"} — set strictly AFTER apply_spec commits (handover §4.3;
// compute/readiness.ts) — before ever reporting the endpoint "running". ensureRunning() cannot
// return here until that gate has already passed, so a fresh connect() below no longer needs (or
// should mask) that specific failure mode; any auth failure surfacing past this point is a real one.
//
// The SQL console connects to 127.0.0.1:<port> INSIDE the container — the daemon shares the
// network namespace with computes (they're child processes of this same daemon, not separate
// containers), so container-internal loopback is the correct address here, unlike external
// clients (psql from the host, the acceptance test's own connect() helper), which must go through
// the container's PUBLISHED ports instead. This is intentionally the postgres SUPERUSER role over
// an unauthenticated HTTP route — the product intent per spec Sec.Auth's localhost trust model:
// phase 1 has no auth gating in front of the daemon's REST API at all, and the SQL console is not
// a special case carved out from that — anyone who can reach POST /api/sql can run arbitrary SQL,
// including DDL/DROP, as postgres on that branch's endpoint.
export class SqlService {
  constructor(private deps: { branches: BranchesService; endpoints: EndpointsService }) {}

  // Fix 2 (task-9 gate integration): `opts.noAutoStart` exists for exactly one caller — the
  // build-validation gate (compute/builds/validate.ts). The default path below auto-starts via
  // ensureRunning, which shares startLocked's crash recovery: a FAILED compute is stopped and
  // restarted with the currently-ACTIVE build's pgbin (builds.pgbinFor), NOT whatever pgbin the
  // caller originally launched. For POST /api/sql that recovery is the feature; for the gate it
  // would silently swap a crashed CANDIDATE for the old active build mid-validation — and a
  // same-major version() probe still passes, so a broken build would be marked ready. With
  // noAutoStart the endpoint's CURRENT state is read as-is (BranchDetail.connectionString/port
  // are non-null only while the compute is actually running) and a non-running endpoint is a
  // hard error: the gate FAILS, which is the correct outcome for a crashed candidate.
  async run(
    branchId: string,
    query: string,
    opts?: { noAutoStart?: boolean },
  ): Promise<{ rows: unknown[]; rowCount: number; fields: string[]; truncated: boolean }> {
    if (!query.trim()) throw new DevdbError(400, "empty query");
    // ensureRunning is queued and idempotent (EndpointsService.ensureRunning shares startLocked's
    // queued body with start() — see endpoints.ts) — safe to call on every SQL request regardless
    // of whether the endpoint is already up; a no-op statusOf() check inside the lane short-
    // circuits back to the current BranchDetail when it's already "running".
    const detail = opts?.noAutoStart
      ? await this.deps.branches.detail(this.deps.branches.byIdOr404(branchId))
      : await this.deps.endpoints.ensureRunning(branchId);
    const port = detail.port;
    if (!detail.connectionString || !port) {
      throw new DevdbError(502, opts?.noAutoStart
        ? `endpoint for "${detail.name}" is not running — noAutoStart refuses to start one (a crashed compute must surface as a failure, not be silently restarted on a different build)`
        : `endpoint for "${detail.name}" is not running`);
    }
    const client = new pg.Client({
      host: "127.0.0.1", port, user: "postgres",
      password: detail.password, database: "postgres",
      statement_timeout: 30_000,
      // statement_timeout is a session setting the submitted SQL can override (SET statement_timeout=0);
      // query_timeout is driver-side and cannot be — the finally-end() then drops the connection,
      // cancelling the backend.
      query_timeout: 35_000,
      connectionTimeoutMillis: 10_000,
    });
    try {
      await client.connect();
    } catch (e) {
      // A connect() failure can still leave a partially-open TCP socket (auth happens after the
      // transport connects) — end() is a documented no-op if the connection truly never got
      // underway (pg's own client.js: `!this.connection._connecting || this._ended`), so calling
      // it unconditionally here is safe cleanup, never a spurious error against nothing.
      await client.end().catch(() => {});
      throw e;
    }
    try {
      const res = await client.query(query);
      // Simple-query protocol returns an ARRAY of results for multi-statement strings; report the last
      // result carrying rows (psql display convention).
      const results = Array.isArray(res) ? res : [res];
      const last =
        [...results].reverse().find((r) => (r.rows?.length ?? 0) > 0) ?? results[results.length - 1]!;
      const allRows = last.rows ?? [];
      const rows = allRows.slice(0, 1000);
      return {
        rows,
        rowCount: last.rowCount ?? allRows.length,
        fields: (last.fields ?? []).map((f: { name: string }) => f.name),
        truncated: allRows.length > rows.length,
      };
    } finally {
      await client.end();
    }
  }
}

/**
 * Accepted limitations:
 * 1. Full result materializes in daemon memory before capping to 1000 rows — streaming/pagination is a later-phase concern.
 * 2. Object-keyed rows collapse duplicate column names — alias columns if you need both; object rows chosen deliberately for agent/MCP ergonomics.
 */
