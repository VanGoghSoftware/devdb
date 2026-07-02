import type { EndpointStatus, PgVersion } from "@devdb/shared";
import type { TenantConfigJson } from "../engine/storcon-client.js";
import type { TimelineInfoJson } from "../engine/pageserver-client.js";
import type { BranchRow } from "../state/repos.js";

// Narrow structural interfaces containing exactly the methods services consume from the
// engine clients and compute manager. Services depend on these, not on the concrete classes,
// so unit tests can supply plainly-typed fakes (vi.fn stubs) without `as never` casts — the
// TypeScript compiler enforces that fakes actually satisfy what the service calls.
//
// Amendment A2 (controller): replaces the brief's `as never`-cast partial fakes with these
// typed interfaces + typed fakes. See task-12-report.md.

export interface StorconApi {
  tenantCreate(tenantId: string, config: TenantConfigJson): Promise<void>;
  getLsnByTimestamp(tenantId: string, timelineId: string, isoTimestamp: string): Promise<{ lsn: string; kind: string }>;
}

export interface PageserverApi {
  timelineCreate(tenantId: string, req: { new_timeline_id: string } & Record<string, unknown>): Promise<TimelineInfoJson>;
  timelineInfo(tenantId: string, timelineId: string): Promise<TimelineInfoJson>;
  timelineDelete(tenantId: string, timelineId: string): Promise<void>;
  timelineDetachAncestor(tenantId: string, timelineId: string): Promise<{ reparented_timelines: string[] }>;
  tenantDelete(tenantId: string): Promise<void>;
}

export interface SafekeeperApi {
  timelineDelete(tenantId: string, timelineId: string): Promise<void>;
  tenantDelete(tenantId: string): Promise<void>;
}

export interface ComputesApi {
  start(a: { branch: BranchRow; pgVersion: PgVersion }): Promise<{ port: number }>;
  stop(branchId: string): Promise<void>;
  statusOf(branchId: string): EndpointStatus;
  portOf(branchId: string): number | null;
  runningPorts(): Array<{ branchId: string; port: number }>;
  onLine(branchId: string, cb: (line: string) => void): () => void;
  stopAll(): Promise<void>;
}
