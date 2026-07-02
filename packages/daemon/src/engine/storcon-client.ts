import { engineFetch } from "./http.js";

export interface TenantConfigJson {
  gc_period: string; gc_horizon: number; pitr_interval: string;
  checkpoint_distance: number; checkpoint_timeout: string;
}

export class StorconClient {
  constructor(private base = "http://127.0.0.1:1234") {}

  // oracle: src/mgmt/service/project.rs:95-123 — POST /v1/tenant, expect 201.
  // VERIFY on first live run: duration/byte field encodings (humantime strings vs numbers);
  // authoritative shape: neon submodule libs/pageserver_api/src/models.rs TenantCreateRequest/TenantConfig.
  async tenantCreate(tenantId: string, config: TenantConfigJson): Promise<void> {
    await engineFetch("tenant_create", `${this.base}/v1/tenant`, {
      method: "POST",
      body: JSON.stringify({
        new_tenant_id: tenantId,
        generation: null,
        placement_policy: null,
        config,
      }),
    }, [201]);
  }

  // oracle: src/mgmt/service/branch.rs:570-599 — storcon proxies this pageserver route.
  async getLsnByTimestamp(tenantId: string, timelineId: string, isoTimestamp: string): Promise<{ lsn: string; kind: string }> {
    const url = `${this.base}/v1/tenant/${tenantId}/timeline/${timelineId}/get_lsn_by_timestamp?timestamp=${encodeURIComponent(isoTimestamp)}`;
    const res = await engineFetch("get_lsn_by_timestamp", url, {}, [200]);
    return (await res.json()) as { lsn: string; kind: string };
  }
}
