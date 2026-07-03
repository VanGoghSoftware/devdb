import type { BranchDto, ProjectDto, EndpointStatus } from "@devdb/shared";
import type { ProjectRow } from "../state/repos.js";
import type { BranchDetail } from "./branches.js";

export function toProjectDto(p: ProjectRow): ProjectDto {
  return { id: p.id, name: p.name, pgVersion: p.pgVersion, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

export function toBranchDto(b: BranchDetail): BranchDto {
  return {
    id: b.id, projectId: b.projectId, parentBranchId: b.parentBranchId, name: b.name, slug: b.slug,
    timelineId: b.timelineId, endpointStatus: b.endpointStatus as EndpointStatus,
    endpointError: b.endpointError, port: b.port, connectionString: b.connectionString,
    lastRecordLsn: b.lastRecordLsn, logicalSizeBytes: b.logicalSizeBytes, ancestorLsn: b.ancestorLsn,
    createdBy: b.createdBy as BranchDto["createdBy"], context: b.context,
    createdAt: b.createdAt, updatedAt: b.updatedAt,
  };
}
