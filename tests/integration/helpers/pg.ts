import pg from "pg";
import type { Devdb } from "./container.js";
import { isTransientConnError, withRetryableResource, type RetryOpts } from "./retry.js";

// Amendment A1 (controller): shared helpers extracted from the brief's inline
// connect()/api() so later integration tests (endpoints, PITR, etc.) import the same
// implementation instead of re-declaring it per test file.

// Task 5: connectWithRetry() (bounded retry on "password authentication failed", Task 14) used
// to paper over a real race in compute_ctl's startup — POST .../endpoint/start could return 200
// (readyNeedle matched, EndpointsService reports "running") slightly BEFORE apply_spec had
// actually committed the branch's first-ever SCRAM verifier, so a connect() issued immediately
// after could land in that gap. That gap is now closed structurally: ComputeManager.start()
// blocks on waitComputeReady() polling compute_ctl_up{status="running"} — set strictly AFTER
// apply_spec commits (handover §4.3; packages/daemon/src/compute/readiness.ts) — before the
// endpoint is ever reported "running", so a connect() issued right after this helper's caller
// sees a 200 no longer needs (or should mask) that specific failure mode.
export async function connect(dev: Devdb, connectionString: string): Promise<pg.Client> {
  const url = new URL(connectionString);
  const client = new pg.Client({
    // Dial the emitted host verbatim — now the IPv4 literal 127.0.0.1 (see services/branches.ts),
    // the exact host external clients copy — so a regression back to "localhost" would surface
    // here too, not just in the unit assertion. Only the PORT is remapped: the connstring's port
    // is the container-internal endpoint port, which testcontainers republishes on a random host
    // port (compose's fixed 127.0.0.1:54300-54339 binding isn't in play under testcontainers).
    host: url.hostname,
    port: dev.mappedPort(Number(url.port)),
    user: url.username,
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
  });
  try {
    await client.connect();
  } catch (e) {
    // A rejected connect() can still leave a partially-open TCP socket (auth happens after the
    // transport connects), and this is exactly the transient path withConnection retries — so a
    // bare rethrow would leak one client per failed attempt. Release it first, mirroring the
    // daemon's own SQL path (packages/daemon/src/services/sql.ts): end() is a documented no-op
    // when the connection never got underway (pg client.js: `!this.connection._connecting ||
    // this._ended`), so this is safe cleanup, never a spurious error — and the original connect
    // error is what must surface.
    await client.end().catch(() => {});
    throw e;
  }
  return client;
}

// Open a fresh connection to `connectionString`, run `fn`, and always close the connection —
// retrying the WHOLE connect+run cycle on a transient connection teardown (helpers/retry.ts).
//
// Use this for a read issued right after a restore/reset returns a freshly (re)started endpoint:
// TimeTravelService auto-stops+restarts the branch's compute around a restore/reset, and a
// connect+query racing that compute's final startup under load can drop with 57P01 / a socket
// error before postgres is stably accepting (the compute-SIGTERM-mid-query flake — memory
// integration-timetravel-fullsuite-flake). A fresh reconnect is the correct client response.
//
// `fn` MUST be idempotent: it is re-run verbatim on a brand-new connection each attempt (every
// call site is a read-only SELECT assertion, so re-running is safe and the result is
// deterministic — a wrong result therefore still fails every attempt and is NOT masked). The
// retry is deliberately narrow to connection-teardown signatures, so an assertion failure or a
// SQL-semantic error like `relation "t" does not exist` surfaces immediately, unretried.
export async function withConnection<T>(
  dev: Devdb,
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  return withRetryableResource(
    () => connect(dev, connectionString),
    fn,
    // Release the connection each attempt. end() may reject on a half-dead socket, but
    // withRetryableResource discards the release outcome, so that can neither mask fn's result/error
    // nor abort the retry. (connect() owns cleanup of a client whose own connect() rejected — see
    // its catch above.)
    (client) => client.end(),
    isTransientConnError,
    opts,
  );
}

// Poll GET /api/branches/:id/lsn?timestamp=<iso> until it resolves (200). The endpoint returns 400
// with kind:"future" while the queried instant is still ahead of what the pageserver has ingested.
//
// CONFIRMED live (handover §8.5; direct repro against a standalone container, held 40+ seconds with
// zero further writes): kind:"future" is NOT a wall-clock/ingestion-lag condition that clears on its
// own with the mere passage of time — get_lsn_by_timestamp only flips future->present once the
// pageserver ingests a WAL record whose commit timestamp is AFTER the queried instant. A target held
// at "future" for 40+ seconds of pure waiting resolved on the very next poll immediately after a
// single unrelated write landed. So a polling loop with no write activity of its own would spin its
// whole budget and then fail: this must be called only AFTER a commit later than the target is known
// to have landed (both call sites arrange exactly that — see their surrounding comments).
//
// This is therefore the deterministic gate to run BEFORE a time-travel restore to a computed
// timestamp (the same REST resolver restore itself uses internally), replacing a fixed sleep: it
// proves the branch's WAL has advanced past the target before the restore asks for it. Raw fetch,
// not api(), because api() throws on the very 400s this is meant to poll past. Shared by
// timetravel.test.ts and mcp.test.ts.
export async function waitForLsnResolvable(
  dev: Devdb,
  branchId: string,
  isoTimestamp: string,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 20;
  const intervalMs = opts.intervalMs ?? 500;
  const path = `/api/branches/${branchId}/lsn?timestamp=${encodeURIComponent(isoTimestamp)}`;
  let lastBody = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await fetch(`${dev.base}${path}`);
    if (res.status === 200) return;
    lastBody = await res.text();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `GET ${path} never returned 200 within ~${Math.round((attempts * intervalMs) / 1000)}s of polling — last response body: ${lastBody}`,
  );
}

export async function api<T>(dev: Devdb, method: string, path: string, body?: unknown): Promise<T> {
  // Only set content-type when there IS a body: Fastify parses content-type/body before
  // routing, so a POST with content-type: application/json and an empty body throws
  // FST_ERR_CTP_EMPTY_JSON_BODY before the router even gets to report 404 on an unknown
  // path — that would mask the 404 this task's endpoint-start calls are meant to surface.
  const res = await fetch(`${dev.base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
