import { engineFetch } from "./http.js";
import { assertEngineId } from "./ids.js";

export class SafekeeperClient {
  constructor(private base = "http://127.0.0.1:7676") {}

  // oracle: neon safekeeper DELETE /v1/tenant/:tenant_id/timeline/:timeline_id (http/routes.rs, timeline_delete_handler); storage_controller's own typed wrapper is safekeeper_client.rs::delete_timeline.
  async timelineDelete(tenantId: string, timelineId: string): Promise<void> {
    assertEngineId(tenantId);
    assertEngineId(timelineId);
    await engineFetch("sk_timeline_delete", `${this.base}/v1/tenant/${tenantId}/timeline/${timelineId}`, { method: "DELETE" }, [200, 404]);
  }

  // oracle: neon safekeeper DELETE /v1/tenant/:tenant_id (http/routes.rs, tenant_delete_handler); storage_controller's own typed wrapper is safekeeper_client.rs::delete_tenant.
  async tenantDelete(tenantId: string): Promise<void> {
    assertEngineId(tenantId);
    await engineFetch("sk_tenant_delete", `${this.base}/v1/tenant/${tenantId}`, { method: "DELETE" }, [200, 404]);
  }
}
