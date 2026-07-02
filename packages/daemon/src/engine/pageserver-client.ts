import { engineFetch } from "./http.js";

export interface TimelineInfoJson {
  timeline_id: string;
  ancestor_timeline_id?: string | null;
  ancestor_lsn?: string | null;
  last_record_lsn?: string | null;
  current_logical_size?: number | null;
}

export class PageserverClient {
  constructor(private base = "http://127.0.0.1:9898") {}

  private tl(tenantId: string, timelineId: string): string {
    return `${this.base}/v1/tenant/${tenantId}/timeline/${timelineId}`;
  }

  // oracle: src/mgmt/service/branch.rs:141-152 (create), 675-701 (create at LSN).
  // Body is TimelineCreateRequest with the mode variant's fields flattened
  // (branch: ancestor_timeline_id [+ ancestor_start_lsn]; bootstrap: pg_version).
  async timelineCreate(tenantId: string, req: { new_timeline_id: string } & Record<string, unknown>): Promise<TimelineInfoJson> {
    const res = await engineFetch("timeline_create", `${this.base}/v1/tenant/${tenantId}/timeline`, {
      method: "POST", body: JSON.stringify(req),
    }, [200, 201]);
    return (await res.json()) as TimelineInfoJson;
  }

  // oracle: src/mgmt/service/branch.rs:251-260 timeline_info(ForceAwaitLogicalSize::No)
  async timelineInfo(tenantId: string, timelineId: string): Promise<TimelineInfoJson> {
    const res = await engineFetch("timeline_info", this.tl(tenantId, timelineId), {}, [200]);
    return (await res.json()) as TimelineInfoJson;
  }

  // oracle: src/mgmt/service/branch.rs:487. Deletion is async on the engine side (202).
  async timelineDelete(tenantId: string, timelineId: string): Promise<void> {
    await engineFetch("timeline_delete", this.tl(tenantId, timelineId), { method: "DELETE" }, [200, 202, 404]);
  }

  // oracle: src/mgmt/service/branch.rs:703-736
  async timelineDetachAncestor(tenantId: string, timelineId: string): Promise<{ reparented_timelines: string[] }> {
    const res = await engineFetch(
      "timeline_detach_ancestor",
      `${this.tl(tenantId, timelineId)}/detach_ancestor`,
      { method: "PUT" },
      [200],
    );
    return (await res.json()) as { reparented_timelines: string[] };
  }

  // oracle: src/mgmt/service/project.rs:375
  async tenantDelete(tenantId: string): Promise<void> {
    await engineFetch("tenant_delete", `${this.base}/v1/tenant/${tenantId}`, { method: "DELETE" }, [200, 202, 404]);
  }
}
