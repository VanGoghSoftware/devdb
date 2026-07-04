import type { BranchDto, PgBuildDto, ProjectDto } from "@devdb/shared";
import type { PgBuildRow, ProjectRow } from "../state/repos.js";
import type { BranchDetail } from "./branches.js";

export function toProjectDto(p: ProjectRow): ProjectDto {
  return { id: p.id, name: p.name, pgVersion: p.pgVersion, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

export function toBranchDto(b: BranchDetail): BranchDto {
  return {
    id: b.id, projectId: b.projectId, parentBranchId: b.parentBranchId, name: b.name, slug: b.slug,
    timelineId: b.timelineId, endpointStatus: b.endpointStatus, // BranchDetail already carries the narrow status type
    endpointError: b.endpointError, port: b.port, connectionString: b.connectionString,
    lastRecordLsn: b.lastRecordLsn, logicalSizeBytes: b.logicalSizeBytes, ancestorLsn: b.ancestorLsn,
    createdBy: b.createdBy, context: b.context, // BranchRow now carries the union
    createdAt: b.createdAt, updatedAt: b.updatedAt,
    runningPgVersion: b.runningPgVersion, // Task 8: BranchDetail now resolves the real value
  };
}

// Task 10 (dynamic-pg-builds): row -> wire DTO for GET /api/pg-builds and the activate route's
// response. `inUse` is derived here (not stored) from the CURRENT runningPgbins() snapshot the
// caller passes in — a prefix match against `row.path + "/"` (not exact equality against a full
// pgbin path) because BuildRegistry.assertRemovable uses the same "startsWith(path + '/')" test
// for its own in-use guard (registry.ts), and this mapper is meant to agree with that guard's
// notion of "in use" rather than encode a second, subtly different one.
export function toPgBuildDto(row: PgBuildRow, runningPgbins: string[]): PgBuildDto {
  return {
    id: row.id, major: row.major, minor: row.minor,
    version: row.minor === null ? null : `${row.major}.${row.minor}`,
    source: row.source, releaseTag: row.releaseTag, imageDigest: row.imageDigest,
    status: row.status, active: row.active,
    inUse: runningPgbins.some((p) => p.startsWith(row.path + "/")),
    sizeBytes: row.sizeBytes, error: row.error, createdAt: row.createdAt,
  };
}
