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
  lastRecordLsn: string | null;
  logicalSizeBytes: number | null;
  createdBy: "ui" | "api" | "mcp";
  createdAt: string;
  updatedAt: string;
}

export interface StatusDto {
  version: string;
  healthy: boolean;
  engine: Record<string, { state: "running" | "stopped" | "failed"; pid: number | null }>;
}
