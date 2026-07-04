import { describe, expect, it } from "vitest";
import { toBranchDto, toPgBuildDto } from "../src/services/dto.js";
import type { BranchDetail } from "../src/services/branches.js";
import type { PgBuildRow } from "../src/state/repos.js";

const detail: BranchDetail = {
  id: "b1", projectId: "p1", parentBranchId: null, name: "main", slug: "s",
  timelineId: "t".repeat(32), password: "SECRET", stickyPort: 54301, endpointStatus: "running",
  endpointError: null, importStatus: "none", importError: null, createdBy: "mcp",
  createdAt: "2026-07-03T00:00:00.000Z", updatedAt: "2026-07-03T00:00:00.000Z",
  context: { agent: "claude", purpose: "x" },
  port: 54301, connectionString: "postgresql://postgres:SECRET@localhost:54301/postgres",
  lastRecordLsn: "0/1", logicalSizeBytes: 10, ancestorLsn: null,
  runningPgVersion: "17.4",
};

describe("toBranchDto", () => {
  it("drops password but keeps connectionString + context", () => {
    const dto = toBranchDto(detail);
    expect("password" in dto).toBe(false);
    expect(dto.connectionString).toContain("SECRET"); // connstring is how the agent gets creds
    expect(dto.context).toEqual({ agent: "claude", purpose: "x" });
    expect(dto.ancestorLsn).toBeNull();
  });
  it("does not leak internal-only columns", () => {
    const dto = toBranchDto(detail) as unknown as Record<string, unknown>;
    for (const k of ["stickyPort", "importStatus", "importError"]) expect(k in dto).toBe(false);
  });
  // Task 8: toBranchDto now maps BranchDetail.runningPgVersion straight through (replacing the
  // Task-1 hardcoded-null stopgap) — covered for both a real value and the stopped/unresolved null.
  it("maps runningPgVersion through from BranchDetail", () => {
    expect(toBranchDto(detail).runningPgVersion).toBe("17.4");
    expect(toBranchDto({ ...detail, runningPgVersion: null }).runningPgVersion).toBeNull();
  });
});

describe("toPgBuildDto", () => {
  const base: PgBuildRow = {
    id: "b1", major: 17, minor: 5, source: "downloaded", releaseTag: "latest",
    imageDigest: "sha256:" + "a".repeat(64), path: "/data/pg_builds/v17/aaaa", status: "ready",
    active: true, sizeBytes: 123, error: null, createdAt: "2026-07-05T00:00:00.000Z",
  };

  // FIX-4 (final whole-branch review): rows that failed before setDigestPath (and, post FIX-3,
  // every failure-rm'd row) carry path === "". The prefix test `pgbin.startsWith(row.path + "/")`
  // degenerates to startsWith("/") — matching EVERY running pgbin — so such rows reported
  // inUse: true on the wire whenever anything at all was running. Empty-path rows own no
  // directory; they can never be in use.
  it("an empty-path row is never inUse, even with endpoints running", () => {
    const failed: PgBuildRow = { ...base, id: "f1", path: "", status: "failed", active: false, error: "boom" };
    expect(toPgBuildDto(failed, ["/data/pg_builds/v17/aaaa/bin/postgres"]).inUse).toBe(false);
  });

  it("a real-path row is inUse exactly when a running pgbin sits under its dir", () => {
    expect(toPgBuildDto(base, ["/data/pg_builds/v17/aaaa/bin/postgres"]).inUse).toBe(true);
    expect(toPgBuildDto(base, ["/data/pg_builds/v17/bbbb/bin/postgres"]).inUse).toBe(false);
  });
});
