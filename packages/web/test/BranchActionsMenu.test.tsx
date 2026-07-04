import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { notificationsStore } from "@mantine/notifications";
import { renderApp } from "./render.js";
import { BranchActionsMenu } from "../src/tree/BranchActionsMenu.js";

vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: {
    branches: { delete: vi.fn(), reset: vi.fn(), start: vi.fn(), stop: vi.fn() },
  },
}));
import { api } from "../src/api/client.js";
import type { BranchDto } from "@devdb/shared";

// FULLY-typed fixtures (repo rule: no `as any`/`as never`, tests included).
const childBranch: BranchDto = {
  id: "b-child", projectId: "p1", parentBranchId: "b-main", name: "feature", slug: "feature-s",
  timelineId: "t".repeat(32), endpointStatus: "stopped", endpointError: null, port: null,
  connectionString: null, lastRecordLsn: null, logicalSizeBytes: null, createdBy: "ui",
  context: null, ancestorLsn: null, createdAt: "2026-07-03T00:00:00Z", updatedAt: "2026-07-03T00:00:00Z",
};
const runningChildBranch: BranchDto = {
  ...childBranch, id: "b-running", endpointStatus: "running", port: 54301,
  connectionString: "postgres://user@localhost:54301/main",
};
const rootBranch: BranchDto = {
  ...childBranch, id: "b-root", parentBranchId: null, name: "main",
};

const noop = () => {};

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  // notificationsStore is a module-level singleton (no <Notifications/> is mounted by renderApp,
  // so its content never reaches the DOM — see the "notifies instead" test below); reset it so a
  // notification queued by one test can't leak into the next.
  notificationsStore.setState({ notifications: [], queue: [], defaultPosition: "bottom-right", limit: 5 });
});

function latestNotificationMessage(): string | undefined {
  const all = [...notificationsStore.getState().notifications, ...notificationsStore.getState().queue];
  const last = all.at(-1);
  return typeof last?.message === "string" ? last.message : undefined;
}

async function openMenu(branch: BranchDto) {
  renderApp(<BranchActionsMenu branch={branch} onOpenDrawer={noop} onBranchFrom={noop} />);
  await userEvent.click(await screen.findByLabelText(`actions for ${branch.name}`));
}

describe("BranchActionsMenu", () => {
  describe("Delete", () => {
    it("does not call api.branches.delete when the confirm dialog is dismissed", async () => {
      await openMenu(childBranch);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      await userEvent.click(await screen.findByRole("menuitem", { name: /delete/i }));
      expect(api.branches.delete).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("calls api.branches.delete with the branch id when the confirm dialog is accepted", async () => {
      await openMenu(childBranch);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      await userEvent.click(await screen.findByRole("menuitem", { name: /delete/i }));
      // TanStack Query v5's mutationFn(variables, context) 2-arg shape (see dashboard.test.tsx) —
      // assert on the call's first argument, and use the LAST call since mocks accumulate across
      // `it()`s in this file (vite.config.ts sets no clearMocks/restoreMocks).
      expect(vi.mocked(api.branches.delete).mock.calls.at(-1)?.[0]).toEqual("b-child");
      confirmSpy.mockRestore();
    });
  });

  describe("Reset from parent", () => {
    it("does not call api.branches.reset when the confirm dialog is dismissed", async () => {
      await openMenu(childBranch);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      await userEvent.click(await screen.findByRole("menuitem", { name: /reset from parent/i }));
      expect(api.branches.reset).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("calls api.branches.reset with the branch id when the confirm dialog is accepted", async () => {
      await openMenu(childBranch);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      await userEvent.click(await screen.findByRole("menuitem", { name: /reset from parent/i }));
      expect(vi.mocked(api.branches.reset).mock.calls.at(-1)?.[0]).toEqual("b-child");
      confirmSpy.mockRestore();
    });

    it("is disabled for a root branch (parentBranchId === null) and does not fire", async () => {
      await openMenu(rootBranch);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      const item = await screen.findByRole("menuitem", { name: /reset from parent/i });
      expect(item).toBeDisabled();
      // Snapshot call counts rather than asserting `.not.toHaveBeenCalled()` outright: this file's
      // vite.config.ts sets no clearMocks/restoreMocks, so an earlier test's legitimate reset call
      // (confirm=true, above) is still in this mock's history — the assertion must be "no NEW
      // call happened", not "never called at all".
      const callsBefore = vi.mocked(api.branches.reset).mock.calls.length;
      const confirmCallsBefore = confirmSpy.mock.calls.length;
      await userEvent.click(item);
      expect(vi.mocked(api.branches.reset).mock.calls).toHaveLength(callsBefore);
      expect(confirmSpy.mock.calls).toHaveLength(confirmCallsBefore);
      confirmSpy.mockRestore();
    });
  });

  describe("Start/Stop endpoint", () => {
    it("shows Start for a stopped branch and calls api.branches.start on click", async () => {
      await openMenu(childBranch); // endpointStatus: "stopped"
      expect(screen.queryByRole("menuitem", { name: /stop endpoint/i })).not.toBeInTheDocument();
      await userEvent.click(await screen.findByRole("menuitem", { name: /start endpoint/i }));
      expect(vi.mocked(api.branches.start).mock.calls.at(-1)?.[0]).toEqual("b-child");
    });

    it("shows Stop for a running branch and calls api.branches.stop on click", async () => {
      await openMenu(runningChildBranch);
      expect(screen.queryByRole("menuitem", { name: /start endpoint/i })).not.toBeInTheDocument();
      await userEvent.click(await screen.findByRole("menuitem", { name: /stop endpoint/i }));
      expect(vi.mocked(api.branches.stop).mock.calls.at(-1)?.[0]).toEqual("b-running");
    });
  });

  describe("Copy connection string", () => {
    it("awaits the clipboard write and copies the connection string for a running branch", async () => {
      await openMenu(runningChildBranch);
      await userEvent.click(await screen.findByRole("menuitem", { name: /copy connection string/i }));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(runningChildBranch.connectionString);
      // Fix 2: success is only notified after the write PROMISE resolves — the mocked writeText
      // resolves on its own microtask, so by the time userEvent's click has fully settled the
      // success notification (queued only in the .then/await-continuation, never eagerly) must be
      // present. No <Notifications/> is mounted by renderApp, so assert on the store directly
      // (see notificationsStore usage above) rather than the DOM.
      await vi.waitFor(() => expect(latestNotificationMessage()).toMatch(/copied/i));
    });

    it("does not touch the clipboard for a stopped branch (null connectionString) and notifies instead", async () => {
      await openMenu(childBranch); // connectionString: null
      await userEvent.click(await screen.findByRole("menuitem", { name: /copy connection string/i }));
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      expect(latestNotificationMessage()).toMatch(/start it first/i);
    });
  });
});
