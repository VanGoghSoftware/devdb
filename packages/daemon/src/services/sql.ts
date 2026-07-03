import pg from "pg";
import { DevdbError } from "./errors.js";
import type { BranchesService } from "./branches.js";
import type { EndpointsService } from "./endpoints.js";

// Live-found (this task, running the acceptance test against a real container): the SAME race
// tests/integration/helpers/pg.ts's connectWithRetry() documents from Task 14 — compute_ctl
// matches ComputeManager's readyNeedle ("listening on IPv4 address", the postmaster socket bind)
// and EndpointsService reports the branch "running" *before* compute_ctl has finished reconciling
// the SCRAM password/role, so a connect() issued immediately after ensureRunning() resolves can
// land in that gap and fail with "password authentication failed" even though the password is
// correct — a retry ~100-200ms later against a FRESH socket succeeds. pg.ts's helper papers over
// this for TEST connections only; ensureRunning() below is called unconditionally on EVERY
// POST /api/sql (including against an endpoint that just started), so this is a real production
// gap, not a test-only concern. Bounded (5 x 200ms = up to 1s) and scoped to exactly this message —
// any other connect() failure (wrong port, refused, host down) must surface on the very first
// attempt with no added latency, since every other failure looks identical from here and burning
// the whole retry budget on a genuinely-broken connection would be a needless multi-second stall.
//
// Live-found correction: pg.Client instances are single-use — calling .connect() a second time on
// the SAME instance (even after the first attempt threw) throws "Client has already been
// connected. You cannot reuse a client." (confirmed against the real acceptance test, and in
// pg's own client.js source: `end()` is itself a documented no-op when `connection._connecting`
// was never set, i.e. .connect() only ever partially transitions state on the instance it was
// called on — there is no supported "reset and retry" path). So each retry attempt constructs a
// FRESH Client via the supplied factory rather than re-calling .connect() on the one that just
// failed; a failed attempt's client is .end()'d (safe/no-op-if-never-truly-connected per pg's own
// source above, and the correct cleanup on the auth-failure case, where the TCP socket DID open —
// auth happens after the transport connects) before the next attempt's fresh Client is built.
async function connectWithRetry(makeClient: () => pg.Client, attempts = 5, delayMs = 200): Promise<pg.Client> {
  for (let i = 0; i < attempts; i++) {
    const client = makeClient();
    try {
      await client.connect();
      return client;
    } catch (e) {
      await client.end().catch(() => {}); // best-effort — never mask the real connect() error below
      const message = e instanceof Error ? e.message : String(e);
      if (!message.includes("password authentication failed") || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  // unreachable (the loop above always either returns or throws on its last iteration) — satisfies
  // TypeScript's control-flow analysis without an unchecked non-null assertion at every call site.
  throw new Error("connectWithRetry: exhausted attempts without returning or throwing");
}

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

  async run(branchId: string, query: string): Promise<{ rows: unknown[]; rowCount: number; fields: string[] }> {
    if (!query.trim()) throw new DevdbError(400, "empty query");
    // ensureRunning is queued and idempotent (EndpointsService.ensureRunning shares startLocked's
    // queued body with start() — see endpoints.ts) — safe to call on every SQL request regardless
    // of whether the endpoint is already up; a no-op statusOf() check inside the lane short-
    // circuits back to the current BranchDetail when it's already "running".
    const detail = await this.deps.endpoints.ensureRunning(branchId);
    const port = detail.port;
    if (!detail.connectionString || !port) {
      throw new DevdbError(502, `endpoint for "${detail.name}" is not running`);
    }
    const client = await connectWithRetry(() => new pg.Client({
      host: "127.0.0.1", port, user: "postgres",
      password: detail.password, database: "postgres",
      statement_timeout: 30_000, connectionTimeoutMillis: 10_000,
    }));
    try {
      const res = await client.query(query);
      const rows = (res.rows ?? []).slice(0, 1000);
      return { rows, rowCount: res.rowCount ?? rows.length, fields: (res.fields ?? []).map((f) => f.name) };
    } finally {
      await client.end();
    }
  }
}
