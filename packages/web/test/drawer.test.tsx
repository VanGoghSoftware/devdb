import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render.js";
import { BranchDrawer, maskConnstring } from "../src/drawer/BranchDrawer.js";
import { formatBytes } from "../src/drawer/InfoTab.js";

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

// Root fixture (repo convention, see BranchActionsMenu.test.tsx's rootBranch): a root branch has
// no parent and no connection secret to leak here, so it's kept minimal — only the fields the
// root-guard tests touch matter.
const rootBranch: BranchDto = {
  ...branch, id: "b-root", parentBranchId: null, name: "main", connectionString: null,
};

beforeEach(() => {
  vi.mocked(api.branches.get).mockImplementation(async (id: string) =>
    id === rootBranch.id ? rootBranch : branch);
});

describe("maskConnstring", () => {
  // Table-driven: a masking function must fail CLOSED, so every case below asserts the password
  // substring is ABSENT from the output — not just that *some* masking happened — for any scheme,
  // not only the `postgresql://` shape the original (now-fixed) anchored regex assumed.
  const cases: Array<{ name: string; input: string; password: string }> = [
    { name: "postgresql:// (standard scheme)", input: "postgresql://postgres:S3CRET@localhost:54303/postgres", password: "S3CRET" },
    { name: "postgres:// (short scheme — RED pre-fix: the old regex was anchored to `postgresql://` and left this unmasked)", input: "postgres://postgres:S3CRET@host:5432/db", password: "S3CRET" },
    { name: "password containing a colon", input: "postgresql://u:pa:ss@h:1/d", password: "pa:ss" },
  ];

  it.each(cases)("masks the password for $name", ({ input, password }) => {
    const masked = maskConnstring(input);
    expect(masked).not.toContain(password);
  });

  it("leaves a no-password connstring unchanged (no userinfo secret to mask)", () => {
    expect(maskConnstring("postgresql://u@h:1/d")).toBe("postgresql://u@h:1/d");
  });
});

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

  it("root-rename edit state does not survive a switch to the root branch", async () => {
    // Mocks accumulate across `it()`s in this file (vite.config.ts sets no clearMocks/restoreMocks,
    // matching BranchActionsMenu.test.tsx's documented convention) — an earlier test in this file
    // already legitimately called api.branches.rename once, so the assertion below must be "no NEW
    // call happened", not "never called at all".
    const callsBefore = vi.mocked(api.branches.rename).mock.calls.length;

    const { rerender } = renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    // Start editing the CHILD branch: click the pencil, type a draft (do not submit).
    await userEvent.click(await screen.findByRole("button", { name: /rename/i }));
    const input = screen.getByDisplayValue("agent-fix");
    await userEvent.clear(input);
    await userEvent.type(input, "in-progress-draft");

    // Re-render with a ROOT-branch id — this is the same drawer instance observing a branchId
    // change, mirroring a user switching tree selection while an edit was mid-flight.
    rerender(<BranchDrawer branchId="b-root" onClose={() => {}} />);

    // The root's name must render as plain text, and no TextInput must be present: if `editing`
    // state had survived, Enter here would call `rename.mutate` with the root id — a forbidden
    // path the daemon 400s.
    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("in-progress-draft")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /rename/i })).toBeDisabled();
    expect(vi.mocked(api.branches.rename).mock.calls).toHaveLength(callsBefore);
  });

  describe("danger zone: delete", () => {
    it("confirmed: calls api.branches.delete with the id and fires onClose", async () => {
      const onClose = vi.fn();
      vi.spyOn(window, "confirm").mockReturnValue(true);
      vi.mocked(api.branches.delete).mockResolvedValue(undefined);
      renderApp(<BranchDrawer branchId="b1" onClose={onClose} />);
      await userEvent.click(await screen.findByRole("button", { name: /delete branch/i }));
      // TanStack Query v5's mutationFn(variables, context) 2-arg shape (see BranchActionsMenu.test.tsx,
      // dashboard.test.tsx) — assert on the call's first argument, not the full call.
      await waitFor(() => expect(vi.mocked(api.branches.delete).mock.calls.at(-1)?.[0]).toEqual("b1"));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("dismissed: calls neither api.branches.delete nor onClose", async () => {
      const onClose = vi.fn();
      vi.spyOn(window, "confirm").mockReturnValue(false);
      renderApp(<BranchDrawer branchId="b1" onClose={onClose} />);
      const callsBefore = vi.mocked(api.branches.delete).mock.calls.length;
      await userEvent.click(await screen.findByRole("button", { name: /delete branch/i }));
      expect(vi.mocked(api.branches.delete).mock.calls).toHaveLength(callsBefore);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("danger zone: reset from parent", () => {
    it("dismissed: does not call api.branches.reset", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
      const callsBefore = vi.mocked(api.branches.reset).mock.calls.length;
      await userEvent.click(await screen.findByRole("button", { name: /reset from parent/i }));
      expect(vi.mocked(api.branches.reset).mock.calls).toHaveLength(callsBefore);
    });

    it("confirmed (child branch): calls api.branches.reset with the id", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      vi.mocked(api.branches.reset).mockResolvedValue(branch);
      renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
      await userEvent.click(await screen.findByRole("button", { name: /reset from parent/i }));
      await waitFor(() => expect(vi.mocked(api.branches.reset).mock.calls.at(-1)?.[0]).toEqual("b1"));
    });

    it("root branch: Reset control is disabled and never confirms or mutates", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      renderApp(<BranchDrawer branchId="b-root" onClose={() => {}} />);
      const resetButton = await screen.findByRole("button", { name: /reset from parent/i });
      expect(resetButton).toBeDisabled();
      const callsBefore = vi.mocked(api.branches.reset).mock.calls.length;
      const confirmCallsBefore = confirmSpy.mock.calls.length;
      await userEvent.click(resetButton);
      expect(vi.mocked(api.branches.reset).mock.calls).toHaveLength(callsBefore);
      expect(confirmSpy.mock.calls).toHaveLength(confirmCallsBefore);
    });
  });
});

describe("formatBytes", () => {
  // Table-driven: pins the KB/MB/GB thresholds and null handling directly, independent of the
  // rendered drawer (which only ever exercises one value via the branch fixture above).
  const cases: Array<{ name: string; input: number | null; expected: string }> = [
    { name: "null", input: null, expected: "—" },
    { name: "sub-KB value", input: 512, expected: "0.5 KB" },
    { name: "exactly 1 KB region", input: 1024, expected: "1.0 KB" },
    { name: "just below 1 MB", input: 1024 * 1024 - 1, expected: "1024.0 KB" },
    { name: "at 1 MB", input: 1024 * 1024, expected: "1.0 MB" },
    { name: "just below 1 GB", input: 1024 * 1024 * 1024 - 1, expected: "1024.0 MB" },
    { name: "at 1 GB", input: 1024 * 1024 * 1024, expected: "1.00 GB" },
  ];

  it.each(cases)("formats $name as $expected", ({ input, expected }) => {
    expect(formatBytes(input)).toBe(expected);
  });
});
