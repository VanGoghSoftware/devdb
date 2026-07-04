import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render.js";
import { DashboardPage } from "../src/pages/DashboardPage.js";

vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: {
    status: vi.fn(),
    projects: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    branches: {},
  },
}));
import { api } from "../src/api/client.js";
import type { BranchDto, ProjectDto, StatusDto } from "@devdb/shared";

// FULLY-typed fixtures (repo rule: no `as any`/`as never`, tests included). Because the fixtures
// carry their DTO types, vi.mocked(api.x).mockResolvedValue(fixture) needs no cast at all —
// the mock's generic flows from the real module's type through vi.mocked.
const status: StatusDto = {
  version: "0.1.0", healthy: true,
  engine: { pageserver: { state: "running", pid: 1 }, safekeeper: { state: "running", pid: 2 } },
  portRange: { min: 54300, max: 54339 }, storage: "none",
};
const projects: ProjectDto[] = [
  { id: "p1", name: "shop-api", pgVersion: 17, createdAt: "2026-07-03T00:00:00Z", updatedAt: "2026-07-03T00:00:00Z" },
];
const mainBranch: BranchDto = {
  id: "b-main", projectId: "p1", parentBranchId: null, name: "main", slug: "main-s",
  timelineId: "t".repeat(32), endpointStatus: "stopped", endpointError: null, port: null,
  connectionString: null, lastRecordLsn: null, logicalSizeBytes: null, createdBy: "ui",
  context: null, ancestorLsn: null, createdAt: "2026-07-03T00:00:00Z", updatedAt: "2026-07-03T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(api.status).mockResolvedValue(status);
  vi.mocked(api.projects.list).mockResolvedValue(projects);
});

describe("DashboardPage", () => {
  it("renders engine component chips, storage chip, and project cards", async () => {
    renderApp(<DashboardPage />);
    expect(await screen.findByText("shop-api")).toBeInTheDocument();
    expect(screen.getByText(/pageserver/)).toBeInTheDocument();
    expect(screen.getByText(/local storage/i)).toBeInTheDocument();
    expect(screen.getByText(/PG 17/)).toBeInTheDocument();
  });

  it("shows a degraded banner when unhealthy", async () => {
    vi.mocked(api.status).mockResolvedValue({ ...status, healthy: false, engine: { pageserver: { state: "failed", pid: null } } });
    renderApp(<DashboardPage />);
    expect(await screen.findByText(/engine degraded/i)).toBeInTheDocument();
  });

  it("creates a project through the modal with a PG version picker", async () => {
    vi.mocked(api.projects.create).mockResolvedValue({ project: projects[0]!, mainBranch });
    renderApp(<DashboardPage />);
    await userEvent.click(await screen.findByRole("button", { name: /new project/i }));
    await userEvent.type(await screen.findByLabelText(/name/i), "billing");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    // TanStack Query v5's mutation executor always calls mutationFn(variables, mutationFnContext) —
    // the 2nd arg ({ client, meta, mutationKey }) is Query's own resumable-mutations context, not
    // something useApiMutation adds (verified in @tanstack/query-core@5.101.2's mutation.ts#execute).
    // Assert on the first call argument only; toHaveBeenCalledWith would require matching both.
    await waitFor(() => expect(vi.mocked(api.projects.create).mock.calls[0]?.[0]).toEqual({ name: "billing", pgVersion: 17 }));
  });
});
