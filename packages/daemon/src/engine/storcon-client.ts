import { EngineApiError, engineFetch, parseJson } from "./http.js";
import { assertEngineId } from "./ids.js";

export interface TenantConfigJson {
  gc_period: string; gc_horizon: number; pitr_interval: string;
  checkpoint_distance: number; checkpoint_timeout: string;
}

// CONFIRMED live (storage_controller, 2026-07-02, container run — see task-12-report.md for the
// full timestamped log excerpt): immediately after boot reports every component "running", a
// freshly re-attached pageserver is marked "warming-up" by the storage controller and only
// becomes schedulable on its *next* heartbeat tick (observed fixed ~5s cadence, driven entirely
// inside storage_controller, independent of our boot sequence). A tenant_create landing in that
// window is well-formed but gets rejected:
//   409 {"msg":"Conflict: Failed to schedule shard(s): No pageserver found matching constraint"}
// This substring match is intentionally narrow — it must not swallow a real/permanent 409 (e.g.
// "tenant already exists", genuine scheduling failure with 0 pageservers registered at all).
const TRANSIENT_SCHEDULING_MSG = "Failed to schedule shard(s): No pageserver found matching constraint";

export class StorconClient {
  // sleepMs is injectable so tests can exercise the retry loop without waiting out the real
  // backoff; production callers get the real setTimeout-based sleep via the default.
  constructor(
    private base = "http://127.0.0.1:1234",
    private sleepMs: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  // oracle: src/mgmt/service/project.rs:95-123 — POST /v1/tenant, expect 201.
  // CONFIRMED live (storage_controller, 2026-07-02): TenantCreateRequest has no nested `config`
  // field — sending one 400s with "unknown field `config`". The TenantConfig fields flatten
  // directly onto the top-level request body alongside new_tenant_id/generation/placement_policy.
  // Verified by round-trip: GET /v1/tenant/:id/config afterward echoed tenant_specific_overrides
  // matching every field sent (duration fields as humantime strings e.g. "1h"/"7 days"/"5m",
  // byte fields as plain numbers — no encoding change needed there, only the flattening).
  //
  // Retries a transient "pageserver not yet schedulable" 409 (see TRANSIENT_SCHEDULING_MSG
  // above) with the same bounded-backoff shape EngineRuntime.registerSafekeeper() already uses
  // for the structurally identical "engine component not immediately ready" problem — just at
  // request-serving time instead of boot time, since this race lives entirely inside the
  // storage controller's own heartbeat loop and isn't observable from our /api/status.
  async tenantCreate(tenantId: string, config: TenantConfigJson): Promise<void> {
    assertEngineId(tenantId);
    const body = JSON.stringify({
      new_tenant_id: tenantId,
      generation: null,
      placement_policy: null,
      ...config,
    });
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await engineFetch("tenant_create", `${this.base}/v1/tenant`, { method: "POST", body }, [201]);
        return;
      } catch (e) {
        const transient = e instanceof EngineApiError && e.status === 409 && e.body.includes(TRANSIENT_SCHEDULING_MSG);
        if (!transient || attempt === maxAttempts) throw e;
        await this.sleepMs(2000 * attempt);
      }
    }
  }

  // oracle: src/mgmt/service/branch.rs:570-599 — storcon proxies this pageserver route.
  async getLsnByTimestamp(tenantId: string, timelineId: string, isoTimestamp: string): Promise<{ lsn: string; kind: string }> {
    assertEngineId(tenantId);
    assertEngineId(timelineId);
    const url = `${this.base}/v1/tenant/${tenantId}/timeline/${timelineId}/get_lsn_by_timestamp?timestamp=${encodeURIComponent(isoTimestamp)}`;
    const res = await engineFetch("get_lsn_by_timestamp", url, {}, [200]);
    return await parseJson<{ lsn: string; kind: string }>("get_lsn_by_timestamp", res);
  }
}
