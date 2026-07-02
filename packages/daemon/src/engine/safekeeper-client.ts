import { engineFetch } from "./http.js";
import { assertEngineId } from "./ids.js";

export class SafekeeperClient {
  constructor(private base = "http://127.0.0.1:7676") {}

  // oracle: src/mgmt/service/branch.rs:722-731 safekeeper_client.delete_timeline
  async timelineDelete(tenantId: string, timelineId: string): Promise<void> {
    assertEngineId(tenantId);
    assertEngineId(timelineId);
    await engineFetch("sk_timeline_delete", `${this.base}/v1/tenant/${tenantId}/timeline/${timelineId}`, { method: "DELETE" }, [200, 404]);
  }

  // oracle: src/mgmt/service/project.rs:393 safekeeper_client.delete_tenant
  async tenantDelete(tenantId: string): Promise<void> {
    assertEngineId(tenantId);
    await engineFetch("sk_tenant_delete", `${this.base}/v1/tenant/${tenantId}`, { method: "DELETE" }, [200, 404]);
  }
}
