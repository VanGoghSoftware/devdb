import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render.js";
import { BranchDrawer } from "../src/drawer/BranchDrawer.js";

vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: {
    status: vi.fn(), projects: {},
    branches: { get: vi.fn(), rename: vi.fn(), delete: vi.fn(), reset: vi.fn(), start: vi.fn(), stop: vi.fn(), restore: vi.fn(), list: vi.fn(), create: vi.fn() },
  },
}));
import { api } from "../src/api/client.js";
import type { BranchDto } from "@devdb/shared";

const branch: BranchDto = {
  id: "b1", projectId: "p1", parentBranchId: "b-main", name: "agent-fix", slug: "agent-fix-s",
  timelineId: "t".repeat(32), endpointStatus: "running", endpointError: null, port: 54303,
  connectionString: "postgresql://postgres:S3CRET@localhost:54303/postgres",
  lastRecordLsn: "0/169AD58", logicalSizeBytes: 24117248, createdBy: "mcp",
  context: { agent: "claude", git_branch: "fix-1", purpose: "repro the bug" },
  ancestorLsn: "0/1690000", createdAt: "2026-07-03T10:00:00Z", updatedAt: "2026-07-03T10:00:00Z",
};

beforeEach(() => vi.mocked(api.branches.get).mockResolvedValue(branch));

describe("BranchDrawer", () => {
  it("shows masked connstring; copy writes the real one", async () => {
    const write = vi.fn();
    Object.assign(navigator, { clipboard: { writeText: write } });
    renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    expect(await screen.findByText(/postgresql:\/\/postgres:•••@localhost:54303/)).toBeInTheDocument();
    expect(screen.queryByText(/S3CRET/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(write).toHaveBeenCalledWith(branch.connectionString);
  });

  it("renames inline through the pencil", async () => {
    vi.mocked(api.branches.rename).mockResolvedValue({ ...branch, name: "better-name" });
    renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /rename/i }));
    const input = screen.getByDisplayValue("agent-fix");
    await userEvent.clear(input);
    await userEvent.type(input, "better-name{enter}");
    await waitFor(() => expect(api.branches.rename).toHaveBeenCalledWith("b1", "better-name"));
  });

  it("shows fork context and Info metadata", async () => {
    renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    expect(await screen.findByText(/repro the bug/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /info/i }));
    expect(screen.getByText("0/169AD58")).toBeInTheDocument();
    expect(screen.getByText(/23\.0 MB/)).toBeInTheDocument(); // 24117248 bytes
  });

  it("danger zone: delete confirms then mutates", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.branches.delete).mockResolvedValue(undefined);
    renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /delete branch/i }));
    // TanStack Query v5's mutationFn(variables, context) 2-arg shape (see BranchActionsMenu.test.tsx,
    // dashboard.test.tsx) — assert on the call's first argument, not the full call.
    await waitFor(() => expect(vi.mocked(api.branches.delete).mock.calls.at(-1)?.[0]).toEqual("b1"));
  });
});
