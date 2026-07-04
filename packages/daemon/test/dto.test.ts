import { describe, expect, it } from "vitest";
import { toBranchDto } from "../src/services/dto.js";
import type { BranchDetail } from "../src/services/branches.js";

const detail: BranchDetail = {
  id: "b1", projectId: "p1", parentBranchId: null, name: "main", slug: "s",
  timelineId: "t".repeat(32), password: "SECRET", stickyPort: 54301, endpointStatus: "running",
  endpointError: null, importStatus: "none", importError: null, createdBy: "mcp",
  createdAt: "2026-07-03T00:00:00.000Z", updatedAt: "2026-07-03T00:00:00.000Z",
  context: { agent: "claude", purpose: "x" },
  port: 54301, connectionString: "postgresql://postgres:SECRET@localhost:54301/postgres",
  jdbcUrl: "jdbc:postgresql://127.0.0.1:54301/postgres?user=postgres&password=SECRET&sslmode=disable",
  lastRecordLsn: "0/1", logicalSizeBytes: 10, ancestorLsn: null,
};

describe("toBranchDto", () => {
  it("drops password but keeps connectionString + context", () => {
    const dto = toBranchDto(detail);
    expect("password" in dto).toBe(false);
    expect(dto.connectionString).toContain("SECRET"); // connstring is how the agent gets creds
    expect(dto.jdbcUrl).toBe("jdbc:postgresql://127.0.0.1:54301/postgres?user=postgres&password=SECRET&sslmode=disable");
    expect(dto.context).toEqual({ agent: "claude", purpose: "x" });
    expect(dto.ancestorLsn).toBeNull();
  });
  it("does not leak internal-only columns", () => {
    const dto = toBranchDto(detail) as unknown as Record<string, unknown>;
    for (const k of ["stickyPort", "importStatus", "importError"]) expect(k in dto).toBe(false);
  });
});
