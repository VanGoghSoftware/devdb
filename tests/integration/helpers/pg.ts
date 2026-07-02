import pg from "pg";
import type { Devdb } from "./container.js";

// Amendment A1 (controller): shared helpers extracted from the brief's inline
// connect()/api() so later integration tests (endpoints, PITR, etc.) import the same
// implementation instead of re-declaring it per test file.

export async function connect(dev: Devdb, connectionString: string): Promise<pg.Client> {
  const url = new URL(connectionString);
  const client = new pg.Client({
    host: "localhost",
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
