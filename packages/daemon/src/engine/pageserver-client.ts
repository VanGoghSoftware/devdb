import { engineFetch, parseJson } from "./http.js";
import { assertEngineId } from "./ids.js";

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

  // oracle: neon pageserver POST /v1/tenant/:tenant_shard_id/timeline (routes.rs; create + create-at-LSN via `ancestor_start_lsn`), contract in http/openapi_spec.yml.
  // Body is TimelineCreateRequest with the mode variant's fields flattened
  // (branch: ancestor_timeline_id [+ ancestor_start_lsn]; bootstrap: pg_version).
  async timelineCreate(tenantId: string, req: { new_timeline_id: string } & Record<string, unknown>): Promise<TimelineInfoJson> {
    assertEngineId(tenantId);
    const res = await engineFetch("timeline_create", `${this.base}/v1/tenant/${tenantId}/timeline`, {
      method: "POST", body: JSON.stringify(req),
    }, [200, 201]);
    return await parseJson<TimelineInfoJson>("timeline_create", res);
  }

  // oracle: neon pageserver GET /v1/tenant/:tenant_shard_id/timeline/:timeline_id (routes.rs, timeline_detail_handler; force-await-initial-logical-size query param left unset, i.e. ForceAwaitLogicalSize::No)
  async timelineInfo(tenantId: string, timelineId: string): Promise<TimelineInfoJson> {
    assertEngineId(tenantId);
    assertEngineId(timelineId);
    const res = await engineFetch("timeline_info", this.tl(tenantId, timelineId), {}, [200]);
    return await parseJson<TimelineInfoJson>("timeline_info", res);
  }

  // oracle: neon pageserver DELETE /v1/tenant/:tenant_shard_id/timeline/:timeline_id (routes.rs, timeline_delete_handler). Deletion is async on the engine side (202).
  async timelineDelete(tenantId: string, timelineId: string): Promise<void> {
    assertEngineId(tenantId);
    assertEngineId(timelineId);
    await engineFetch("timeline_delete", this.tl(tenantId, timelineId), { method: "DELETE" }, [200, 202, 404]);
  }

  // oracle: neon pageserver PUT /v1/tenant/:tenant_shard_id/timeline/:timeline_id/detach_ancestor (routes.rs, timeline_detach_ancestor_handler)
  async timelineDetachAncestor(tenantId: string, timelineId: string): Promise<{ reparented_timelines: string[] }> {
    assertEngineId(tenantId);
    assertEngineId(timelineId);
    const res = await engineFetch(
      "timeline_detach_ancestor",
      `${this.tl(tenantId, timelineId)}/detach_ancestor`,
      { method: "PUT" },
      [200],
    );
    return await parseJson<{ reparented_timelines: string[] }>("timeline_detach_ancestor", res);
  }

  // oracle: neon pageserver DELETE /v1/tenant/:tenant_shard_id (routes.rs, tenant_delete_handler)
  async tenantDelete(tenantId: string): Promise<void> {
    assertEngineId(tenantId);
    await engineFetch("tenant_delete", `${this.base}/v1/tenant/${tenantId}`, { method: "DELETE" }, [200, 202, 404]);
  }
}
