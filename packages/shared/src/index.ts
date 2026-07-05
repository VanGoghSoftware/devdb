import { z } from "zod";

export const DEVDB = "devdb";

// Baked fallback list (docker/BINARIES.md inventory). The RUNTIME source of truth for available
// majors is the daemon's BuildRegistry (GET /api/status → pgBuilds; GET /api/pg-builds) — this
// constant exists for UI fallback before status loads and for docs. Order low→high.
export const SUPPORTED_PG_VERSIONS = [14, 15, 16, 17] as const;
// Dynamic-builds phase: majors are registry-validated at runtime (ProjectsService.create), not
// encoded in the type. gte(14) is the floor neon ships; no upper literal so a pulled v18 works.
export const PgVersionSchema = z.number().int().gte(14);
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
  // Version string ("16.9") of the build this branch's RUNNING compute was started from;
  // null when stopped or when the daemon can't resolve the path (registry lookup miss).
  runningPgVersion: string | null;
}

export const PgBuildStatusSchema = z.enum(["downloading", "validating", "ready", "failed"]);
export type PgBuildStatus = z.infer<typeof PgBuildStatusSchema>;

export interface PgBuildDto {
  id: string;
  major: number;
  minor: number | null;          // null until fixup detects it (status "downloading")
  version: string | null;        // "17.5" — render string, null until detected
  source: "baked" | "downloaded";
  releaseTag: string;            // "latest"-resolved tags store the RESOLVED tag when known, else the requested one
  imageDigest: string;           // "sha256:…" — "" for baked rows (not content-addressed)
  status: PgBuildStatus;
  active: boolean;
  inUse: boolean;                // some RUNNING endpoint started from this build's pgbin
  sizeBytes: number | null;
  error: string | null;          // last failure line for status "failed"
  createdAt: string;
}

export interface PgMajorStatusDto {
  activeVersion: string | null;   // "16.9" | null when major has no valid build
  source: "baked" | "downloaded" | null;
  degradedDowngrade: boolean;     // resolution landed below lastRunMinor — never silent (spec decision 10)
  updateAvailable: string | null; // release tag from the LAST explicit check; null = none seen/checked
}

export interface StatusDto {
  version: string;
  healthy: boolean;
  // "starting" added with this phase (deferred widening, handover §5): ManagedProcess reports it
  // between spawn and readyNeedle; the old union silently miscovered that window.
  engine: Record<string, { state: "starting" | "running" | "stopped" | "failed"; pid: number | null }>;
  portRange: { min: number; max: number };
  storage: "none" | "s3" | "azure"; // typed for phase 4; the daemon returns "none" until then
  pgBuilds: Record<string, PgMajorStatusDto>; // keyed by major as string ("16")
}

// Phase 3: /api/events wire schema. Events are coarse INVALIDATION HINTS, never data — the UI
// refetches via REST on receipt (spec 2026-07-03-devdb-phase-3-web-ui-design.md, Decision 1).
// branch.updated covers every branch-row mutation that isn't create/delete: rename, reset,
// in-place restore (timeline swap). LSN/size churn is deliberately NOT an event.
export const DevdbEventTypeSchema = z.enum([
  "project.created", "project.deleted",
  "branch.created", "branch.updated", "branch.deleted",
  "endpoint.status", "engine.health",
  "pg_builds",
]);
export type DevdbEventType = z.infer<typeof DevdbEventTypeSchema>;

export const DevdbEventSchema = z.object({
  type: DevdbEventTypeSchema,
  projectId: z.string().optional(),
  branchId: z.string().optional(),
  at: z.string(), // ISO-8601 with timezone (server-stamped)
}).strict();
export type DevdbEvent = z.infer<typeof DevdbEventSchema>;
