import { z } from "zod";

export const DEVDB = "devdb";

// Adjust to docker/BINARIES.md inventory (Task 2). Order low→high.
export const SUPPORTED_PG_VERSIONS = [14, 15, 16, 17] as const;
export const PgVersionSchema = z.union([z.literal(14), z.literal(15), z.literal(16), z.literal(17)]);
export type PgVersion = z.infer<typeof PgVersionSchema>;
export const DEFAULT_PG_VERSION: PgVersion = 17;

export const EndpointStatusSchema = z.enum(["stopped", "starting", "running", "stopping", "failed"]);
export type EndpointStatus = z.infer<typeof EndpointStatusSchema>;

export const BranchContextSchema = z.object({
  git_branch: z.string().optional(),
  workdir: z.string().optional(),
  agent: z.string().optional(),
  purpose: z.string().optional(),
  client: z.object({ name: z.string(), version: z.string() }).optional(),
});
export type BranchContext = z.infer<typeof BranchContextSchema>;

export interface ProjectDto {
  id: string;
  name: string;
  pgVersion: PgVersion;
  createdAt: string;
  updatedAt: string;
}

export interface BranchDto {
  id: string;
  projectId: string;
  parentBranchId: string | null;
  name: string;
  slug: string;
  timelineId: string;
  endpointStatus: EndpointStatus;
  endpointError: string | null;
  port: number | null;
  connectionString: string | null;
  // JDBC URL for GUI clients (DataGrip/DBeaver): 127.0.0.1, creds as query params, sslmode=disable.
  // null when the endpoint is stopped (same as connectionString).
  jdbcUrl: string | null;
  lastRecordLsn: string | null;
  logicalSizeBytes: number | null;
  createdBy: "ui" | "api" | "mcp";
  context: BranchContext | null;
  ancestorLsn: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StatusDto {
  version: string;
  healthy: boolean;
  engine: Record<string, { state: "running" | "stopped" | "failed"; pid: number | null }>;
  portRange: { min: number; max: number };
  storage: "none" | "s3" | "azure"; // typed for phase 4; the daemon returns "none" until then
}

// Phase 3: /api/events wire schema. Events are coarse INVALIDATION HINTS, never data — the UI
// refetches via REST on receipt (spec 2026-07-03-devdb-phase-3-web-ui-design.md, Decision 1).
// branch.updated covers every branch-row mutation that isn't create/delete: rename, reset,
// in-place restore (timeline swap). LSN/size churn is deliberately NOT an event.
export const DevdbEventTypeSchema = z.enum([
  "project.created", "project.deleted",
  "branch.created", "branch.updated", "branch.deleted",
  "endpoint.status", "engine.health",
]);
export type DevdbEventType = z.infer<typeof DevdbEventTypeSchema>;

export const DevdbEventSchema = z.object({
  type: DevdbEventTypeSchema,
  projectId: z.string().optional(),
  branchId: z.string().optional(),
  at: z.string(), // ISO-8601 with timezone (server-stamped)
}).strict();
export type DevdbEvent = z.infer<typeof DevdbEventSchema>;
