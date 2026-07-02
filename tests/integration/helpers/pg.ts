import pg from "pg";
import type { Devdb } from "./container.js";

// Amendment A1 (controller): shared helpers extracted from the brief's inline
// connect()/api() so later integration tests (endpoints, PITR, etc.) import the same
// implementation instead of re-declaring it per test file.

// CONFIRMED live (Task 14): a real race in compute_ctl's own startup sequence — POST
// .../endpoint/start returns 200 (compute_ctl matched the "listening on IPv4 address" ready
// needle, EndpointsService.start() correctly reports "running") slightly *before* SCRAM auth
// against the configured role is actually usable. Reproduced in isolation outside any test
// framework: connecting within ~10ms of a 200 response reliably fails with "password
// authentication failed for user postgres"; a bare retry ~100ms later against the exact same
// socket succeeds. This is not a config-generation bug (manually verified: psql from inside the
// container and a bare `pg` client from the host both authenticate correctly against a
// freshly-started endpoint once given a moment) — it's a brief window between "postmaster is
// listening" and "role/password reconciliation has landed". A bounded retry-on-auth-failure is
// the same discipline any real client (including Phase 2's MCP layer) will need against the
// actual engine, so it belongs here rather than masked by a manager.ts/spec.ts launch-arg change.
// Capped at 10 attempts x 150ms = 1.5s: long enough to ride out the compute_ctl readiness window
// described above, short enough that a genuinely-wrong password fails the test in ~1.5s instead
// of hanging. Tradeoff: a PERSISTENT auth failure (wrong password, not a timing race) burns the
// full 1.5s window before surfacing, since every attempt looks identical from here — that's an
// accepted test-helper cost, not a fix; the actual daemon-side readiness signal is tracked
// separately rather than papered over by a longer client-side retry loop.
async function connectWithRetry(config: pg.ClientConfig, attempts = 10, delayMs = 150): Promise<pg.Client> {
  let lastErr: unknown;
  const start = Date.now();
  for (let i = 0; i < attempts; i++) {
    const client = new pg.Client(config);
    try {
      await client.connect();
      if (i > 0) console.log(`connectWithRetry: succeeded after ${i + 1} attempt(s), ${Date.now() - start}ms elapsed`);
      return client;
    } catch (e) {
      lastErr = e;
      await client.end().catch(() => {});
      const message = e instanceof Error ? e.message : String(e);
      if (!message.includes("password authentication failed")) throw e; // a different failure must surface immediately
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  console.log(`connectWithRetry: exhausted ${attempts} attempts, ${Date.now() - start}ms elapsed`);
  throw lastErr;
}

export async function connect(dev: Devdb, connectionString: string): Promise<pg.Client> {
  const url = new URL(connectionString);
  return connectWithRetry({
    host: "localhost",
    port: dev.mappedPort(Number(url.port)),
    user: url.username,
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
  });
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
