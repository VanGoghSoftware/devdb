import pg from "pg";
import type { Devdb } from "./container.js";

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
  await client.connect();
  return client;
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
