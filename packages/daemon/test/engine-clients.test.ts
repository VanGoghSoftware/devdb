import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { StorconClient } from "../src/engine/storcon-client.js";
import { PageserverClient } from "../src/engine/pageserver-client.js";
import { SafekeeperClient } from "../src/engine/safekeeper-client.js";
import { newHexId, uuidToHex } from "../src/engine/ids.js";

interface Seen { method: string; url: string; body: string }
let server: http.Server;
let base: string;
let seen: Seen[] = [];
let nextResponse: { status: number; body: string } = { status: 200, body: "{}" };
// Queue of one-shot responses consumed in order before falling back to nextResponse — lets a
// single test simulate a sequence (e.g. transient 409 then 201) without a second harness.
let responseQueue: Array<{ status: number; body: string }> = [];

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method!, url: req.url!, body });
    const r = responseQueue.shift() ?? nextResponse;
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.body);
  });
  server.listen(0);
  await once(server, "listening");
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());
beforeEach(() => { seen = []; nextResponse = { status: 200, body: "{}" }; responseQueue = []; });

describe("ids", () => {
  it("newHexId is 32 hex chars", () => expect(newHexId()).toMatch(/^[0-9a-f]{32}$/));
  it("uuidToHex strips dashes", () =>
    expect(uuidToHex("123e4567-e89b-12d3-a456-426614174000")).toBe("123e4567e89b12d3a456426614174000"));
});

describe("StorconClient", () => {
  it("tenantCreate POSTs oracle payload to /v1/tenant and accepts 201", async () => {
    nextResponse = { status: 201, body: "{}" };
    const c = new StorconClient(base);
    await c.tenantCreate("a".repeat(32), {
      gc_period: "1h", gc_horizon: 67108864, pitr_interval: "7 days",
      checkpoint_distance: 268435456, checkpoint_timeout: "5m",
    });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/tenant" });
    const body = JSON.parse(seen[0]!.body);
    expect(body.new_tenant_id).toBe("a".repeat(32));
    // Confirmed live (2026-07-02): TenantConfig fields flatten onto the top-level request body —
    // a nested `config` field 400s with "unknown field `config`". See storcon-client.ts oracle comment.
    expect(body.config).toBeUndefined();
    expect(body.gc_horizon).toBe(67108864);
    expect(body.gc_period).toBe("1h");
  });

  it("getLsnByTimestamp GETs with timestamp query", async () => {
    nextResponse = { status: 200, body: JSON.stringify({ lsn: "0/1A2B3C", kind: "present" }) };
    const c = new StorconClient(base);
    const out = await c.getLsnByTimestamp("a".repeat(32), "b".repeat(32), "2026-07-02T10:00:00.000Z");
    expect(out).toEqual({ lsn: "0/1A2B3C", kind: "present" });
    expect(seen[0]!.url).toBe(
      `/v1/tenant/${"a".repeat(32)}/timeline/${"b".repeat(32)}/get_lsn_by_timestamp?timestamp=2026-07-02T10%3A00%3A00.000Z`,
    );
  });

  // Confirmed live (2026-07-02, container run): immediately after /api/status first reports all
  // engine components "running", the storage_controller has marked the freshly re-attached
  // pageserver "warming-up" but not yet "active" — its own heartbeat loop (fixed ~5s cadence,
  // independent of daemon boot) is what promotes it to schedulable. A tenant_create landing in
  // that window gets a well-formed-but-rejected 409:
  //   {"msg":"Conflict: Failed to schedule shard(s): No pageserver found matching constraint"}
  // Log evidence (docker logs), timestamps from the same run as the 409 below:
  //   19:35:58.384 storage_controller: "Marking 1 warming-up on reattach"
  //   19:35:59.354 storage_controller: "Error processing HTTP request: Conflict: Failed to
  //                schedule shard(s): No pageserver found matching constraint" (our POST)
  //   (next heartbeat tick, ~5s later, is when the node would have transitioned to active)
  // Retrying tolerates this exactly like registerSafekeeper() already retries storcon
  // registration during boot (engine/boot.ts) — same class of "component not immediately
  // ready" problem, same bounded-backoff shape, just at request-serving time instead of boot time.
  it("retries a transient scheduling 409 on tenantCreate and succeeds once the pageserver is schedulable", async () => {
    responseQueue = [
      { status: 409, body: '{"msg":"Conflict: Failed to schedule shard(s): No pageserver found matching constraint"}' },
      { status: 409, body: '{"msg":"Conflict: Failed to schedule shard(s): No pageserver found matching constraint"}' },
    ];
    nextResponse = { status: 201, body: "{}" };
    // sleepMs injected as a no-op so the test exercises the real retry loop without waiting out
    // the production backoff in wall-clock time.
    const c = new StorconClient(base, async () => {});
    await c.tenantCreate("a".repeat(32), {
      gc_period: "1h", gc_horizon: 1, pitr_interval: "7 days",
      checkpoint_distance: 1, checkpoint_timeout: "5m",
    });
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s.method === "POST" && s.url === "/v1/tenant")).toBe(true);
  });

  it("gives up on tenantCreate after repeated scheduling 409s and surfaces the engine error", async () => {
    nextResponse = { status: 409, body: '{"msg":"Conflict: Failed to schedule shard(s): No pageserver found matching constraint"}' };
    const c = new StorconClient(base, async () => {});
    await expect(c.tenantCreate("a".repeat(32), {
      gc_period: "1h", gc_horizon: 1, pitr_interval: "7 days",
      checkpoint_distance: 1, checkpoint_timeout: "5m",
    })).rejects.toMatchObject({ status: 409, operation: "tenant_create" });
    // Bounded — a permanent 409 (e.g. real scheduling failure) must not retry forever.
    // Exact: maxAttempts is 3, so a persistently-transient 409 must be seen exactly 3 times.
    expect(seen.length).toBe(3);
  });

  it("does not retry a non-scheduling 409 (e.g. a real conflict) on tenantCreate", async () => {
    nextResponse = { status: 409, body: '{"msg":"tenant already exists"}' };
    const c = new StorconClient(base);
    await expect(c.tenantCreate("a".repeat(32), {
      gc_period: "1h", gc_horizon: 1, pitr_interval: "7 days",
      checkpoint_distance: 1, checkpoint_timeout: "5m",
    })).rejects.toMatchObject({ status: 409, operation: "tenant_create" });
    expect(seen).toHaveLength(1);
  });

  it("surfaces engine errors with status and body", async () => {
    nextResponse = { status: 400, body: '{"msg":"bad lsn"}' };
    const c = new StorconClient(base);
    await expect(c.getLsnByTimestamp("a".repeat(32), "b".repeat(32), "x")).rejects.toMatchObject({
      status: 400, operation: "get_lsn_by_timestamp",
    });
  });

  it("rejects malformed engine ids before any request", async () => {
    await expect(new StorconClient(base).tenantCreate("../evil", {
      gc_period: "1h", gc_horizon: 1, pitr_interval: "7 days",
      checkpoint_distance: 1, checkpoint_timeout: "5m",
    })).rejects.toThrow(/invalid engine id/);
    expect(seen).toHaveLength(0);
  });
});

describe("PageserverClient", () => {
  it("timelineCreate POSTs to /v1/tenant/{t}/timeline", async () => {
    nextResponse = { status: 201, body: JSON.stringify({ timeline_id: "c".repeat(32) }) };
    const c = new PageserverClient(base);
    await c.timelineCreate("a".repeat(32), {
      new_timeline_id: "c".repeat(32), ancestor_timeline_id: "b".repeat(32), read_only: false,
    });
    expect(seen[0]).toMatchObject({ method: "POST", url: `/v1/tenant/${"a".repeat(32)}/timeline` });
    expect(JSON.parse(seen[0]!.body).ancestor_timeline_id).toBe("b".repeat(32));
  });

  it("timelineDetachAncestor PUTs and parses reparented list", async () => {
    nextResponse = { status: 200, body: JSON.stringify({ reparented_timelines: ["d".repeat(32)] }) };
    const c = new PageserverClient(base);
    const out = await c.timelineDetachAncestor("a".repeat(32), "c".repeat(32));
    expect(out.reparented_timelines).toEqual(["d".repeat(32)]);
    expect(seen[0]).toMatchObject({
      method: "PUT", url: `/v1/tenant/${"a".repeat(32)}/timeline/${"c".repeat(32)}/detach_ancestor`,
    });
  });

  it("timelineDelete DELETEs and tolerates 202/404", async () => {
    nextResponse = { status: 202, body: "{}" };
    const c = new PageserverClient(base);
    await c.timelineDelete("a".repeat(32), "c".repeat(32));
    nextResponse = { status: 404, body: "{}" };
    await c.timelineDelete("a".repeat(32), "c".repeat(32));
    expect(seen).toHaveLength(2);
  });

  it("rejects malformed engine ids before any request", async () => {
    await expect(new PageserverClient(base).timelineDelete("../evil", "b".repeat(32)))
      .rejects.toThrow(/invalid engine id/);
    expect(seen).toHaveLength(0);
  });

  it("timelineInfo GETs the timeline route", async () => {
    nextResponse = { status: 200, body: JSON.stringify({ timeline_id: "b".repeat(32), last_record_lsn: "0/2" }) };
    const c = new PageserverClient(base);
    const info = await c.timelineInfo("a".repeat(32), "b".repeat(32));
    expect(info.last_record_lsn).toBe("0/2");
    expect(seen[0]).toMatchObject({ method: "GET", url: `/v1/tenant/${"a".repeat(32)}/timeline/${"b".repeat(32)}` });
  });

  it("pageserver tenantDelete tolerates 202", async () => {
    nextResponse = { status: 202, body: "{}" };
    await new PageserverClient(base).tenantDelete("a".repeat(32));
    expect(seen[0]).toMatchObject({ method: "DELETE", url: `/v1/tenant/${"a".repeat(32)}` });
  });

  it("rejects statuses outside the allowlist (tenantCreate 200)", async () => {
    nextResponse = { status: 200, body: "{}" };
    await expect(new StorconClient(base).tenantCreate("a".repeat(32), {
      gc_period: "1h", gc_horizon: 1, pitr_interval: "7 days",
      checkpoint_distance: 1, checkpoint_timeout: "5m",
    })).rejects.toMatchObject({ status: 200, operation: "tenant_create" });
  });

  it("captures the error body on non-ok responses", async () => {
    nextResponse = { status: 500, body: "plain text engine panic" };
    await expect(new PageserverClient(base).timelineInfo("a".repeat(32), "b".repeat(32)))
      .rejects.toMatchObject({ status: 500, body: "plain text engine panic" });
  });

  it("wraps malformed 2xx JSON in EngineApiError", async () => {
    nextResponse = { status: 200, body: "not json {" };
    await expect(new PageserverClient(base).timelineInfo("a".repeat(32), "b".repeat(32)))
      .rejects.toMatchObject({ operation: "timeline_info" });
  });
});

describe("SafekeeperClient", () => {
  it("timelineDelete DELETEs /v1/tenant/{t}/timeline/{tl}", async () => {
    nextResponse = { status: 200, body: "{}" };
    const c = new SafekeeperClient(base);
    await c.timelineDelete("a".repeat(32), "b".repeat(32));
    expect(seen[0]).toMatchObject({
      method: "DELETE", url: `/v1/tenant/${"a".repeat(32)}/timeline/${"b".repeat(32)}`,
    });
  });

  it("safekeeper tenantDelete tolerates 404", async () => {
    nextResponse = { status: 404, body: "{}" };
    await new SafekeeperClient(base).tenantDelete("a".repeat(32));
    expect(seen[0]).toMatchObject({ method: "DELETE", url: `/v1/tenant/${"a".repeat(32)}` });
  });
});
