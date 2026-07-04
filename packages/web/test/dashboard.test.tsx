import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
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
import { SUPPORTED_PG_VERSIONS, DEFAULT_PG_VERSION } from "@devdb/shared";

// FULLY-typed fixtures (repo rule: no `as any`/`as never`, tests included). Because the fixtures
// carry their DTO types, vi.mocked(api.x).mockResolvedValue(fixture) needs no cast at all —
// the mock's generic flows from the real module's type through vi.mocked.
//
// pgBuilds mirrors SUPPORTED_PG_VERSIONS (Task 14): a real running daemon always reports its
// registered majors in status, so an empty pgBuilds isn't a realistic "loaded" default — it's the
// registry-driven-majors tests below (which install their own narrower pgBuilds fixture) that
// exercise the interesting cases. Keeping this default's majors == the baked list means every
// OTHER test in this file (create/delete/degraded/etc., none of which care about the majors set)
// keeps seeing the same PG 14/15/16/17 options and default selection it always has.
const status: StatusDto = {
  version: "0.1.0", healthy: true,
  engine: { pageserver: { state: "running", pid: 1 }, safekeeper: { state: "running", pid: 2 } },
  portRange: { min: 54300, max: 54339 }, storage: "none",
  pgBuilds: Object.fromEntries(
    SUPPORTED_PG_VERSIONS.map((v) => [String(v), { activeVersion: `${v}.0`, source: "baked" as const, degradedDowngrade: false, updateAvailable: null }]),
  ),
};
const projects: ProjectDto[] = [
  { id: "p1", name: "shop-api", pgVersion: 17, createdAt: "2026-07-03T00:00:00Z", updatedAt: "2026-07-03T00:00:00Z" },
];
const mainBranch: BranchDto = {
  id: "b-main", projectId: "p1", parentBranchId: null, name: "main", slug: "main-s",
  timelineId: "t".repeat(32), endpointStatus: "stopped", endpointError: null, port: null,
  connectionString: null, lastRecordLsn: null, logicalSizeBytes: null, createdBy: "ui",
  context: null, ancestorLsn: null, createdAt: "2026-07-03T00:00:00Z", updatedAt: "2026-07-03T00:00:00Z",
  runningPgVersion: null,
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

  it("derives the storage chip from data.storage instead of hardcoding it", async () => {
    vi.mocked(api.status).mockResolvedValue({ ...status, storage: "s3" });
    renderApp(<DashboardPage />);
    expect(await screen.findByText(/s3 storage/i)).toBeInTheDocument();
    expect(screen.queryByText(/local storage/i)).not.toBeInTheDocument();
  });

  it("links each project card to its detail route", async () => {
    renderApp(<DashboardPage />);
    const link = await screen.findByRole("link", { name: /shop-api/i });
    expect(link.getAttribute("href")).toBe("/projects/p1");
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
    // Assert on the call's first argument only; toHaveBeenCalledWith would require matching both.
    // Use the LAST call, not calls[0]: vite.config.ts sets no clearMocks/restoreMocks, so this
    // mock's call history accumulates across every it() in the file that touches api.projects.create.
    await waitFor(() => expect(vi.mocked(api.projects.create).mock.calls.at(-1)?.[0]).toEqual({ name: "billing", pgVersion: 17 }));
  });

  it("drives pgVersion from a non-default Select option and closes the modal on success", async () => {
    vi.mocked(api.projects.create).mockResolvedValue({ project: projects[0]!, mainBranch });
    renderApp(<DashboardPage />);
    await userEvent.click(await screen.findByRole("button", { name: /new project/i }));
    await userEvent.type(await screen.findByLabelText(/name/i), "reporting");

    // Mantine Select renders a read-only combobox <input>; findByLabelText is ambiguous here
    // because the (closed, portalled) options listbox shares the same aria-labelledby as the
    // input, so target the input specifically via its accessible role instead.
    await userEvent.click(await screen.findByRole("combobox", { name: /postgresql version/i }));
    // Mantine's Select dropdown (a Popover) is positioned via Floating UI, which needs real
    // getBoundingClientRect/ResizeObserver measurements to flip its wrapper off `display: none` —
    // jsdom has no layout engine, so that measurement pass never resolves and the wrapper stays
    // `display: none` even though aria-expanded is true and the options are fully in the DOM
    // (verified by waiting 2s of real time in isolation: it never flips). `{ hidden: true }` tells
    // testing-library to include display:none-hidden elements in its accessible-role search; the
    // resulting element is a real, clickable node and clicking it does update the Select's value.
    await userEvent.click(await screen.findByRole("option", { name: "PG 14", hidden: true }));

    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    // Last call, not calls[0] — see the no-clearMocks note on the sibling create test above.
    await waitFor(() =>
      expect(vi.mocked(api.projects.create).mock.calls.at(-1)?.[0]).toEqual({ name: "reporting", pgVersion: 14 }),
    );

    // Modal closed on success — the Name field (only present while the modal is mounted/open) is gone.
    await waitForElementToBeRemoved(() => screen.queryByLabelText(/name/i));
  });

  it("offers exactly the registry-loaded majors (ascending) in the PG version picker, not the baked SUPPORTED_PG_VERSIONS list", async () => {
    vi.mocked(api.status).mockResolvedValue({
      ...status,
      pgBuilds: {
        "16": { activeVersion: "16.10", source: "downloaded", degradedDowngrade: false, updateAvailable: null },
        "17": { activeVersion: "17.5", source: "baked", degradedDowngrade: false, updateAvailable: null },
        "18": { activeVersion: "18.1", source: "downloaded", degradedDowngrade: false, updateAvailable: null },
      },
    });
    renderApp(<DashboardPage />);
    await userEvent.click(await screen.findByRole("button", { name: /new project/i }));
    await userEvent.click(await screen.findByRole("combobox", { name: /postgresql version/i }));

    // Exactly the three registry majors, ascending — SUPPORTED_PG_VERSIONS' 14/15 must NOT appear.
    expect(await screen.findByRole("option", { name: "PG 16", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "PG 17", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "PG 18", hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "PG 14", hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "PG 15", hidden: true })).not.toBeInTheDocument();

    // DEFAULT_PG_VERSION (17) is present among the loaded majors, so it stays the picked value.
    expect(screen.getByRole("combobox", { name: /postgresql version/i })).toHaveValue("PG 17");
  });

  it("falls back to the baked SUPPORTED_PG_VERSIONS list while status is still loading", async () => {
    // Never resolves within the test — mirrors the "loading" state (`useStatus().data` undefined).
    vi.mocked(api.status).mockReturnValue(new Promise(() => {}));
    renderApp(<DashboardPage />);
    await userEvent.click(await screen.findByRole("button", { name: /new project/i }));
    await userEvent.click(await screen.findByRole("combobox", { name: /postgresql version/i }));

    for (const v of SUPPORTED_PG_VERSIONS) {
      expect(await screen.findByRole("option", { name: `PG ${v}`, hidden: true })).toBeInTheDocument();
    }
    expect(screen.getByRole("combobox", { name: /postgresql version/i })).toHaveValue(`PG ${DEFAULT_PG_VERSION}`);
  });

  it("guards project deletion behind window.confirm", async () => {
    vi.mocked(api.projects.delete).mockResolvedValue(undefined);
    renderApp(<DashboardPage />);
    const confirmSpy = vi.spyOn(window, "confirm");

    await userEvent.click(await screen.findByLabelText(/actions for shop-api/i));
    const deleteItem = await screen.findByRole("menuitem", { name: /delete project/i });

    confirmSpy.mockReturnValueOnce(false);
    await userEvent.click(deleteItem);
    expect(api.projects.delete).not.toHaveBeenCalled();

    confirmSpy.mockReturnValueOnce(true);
    await userEvent.click(deleteItem);
    // Same TanStack Query v5 mutationFn(variables, context) 2-arg shape as the create mutation
    // above — assert on the call's first argument only, not toHaveBeenCalledWith("p1"). Use the
    // last call (not calls[0]) for the same no-clearMocks reason noted on the create tests.
    await waitFor(() => expect(vi.mocked(api.projects.delete).mock.calls.at(-1)?.[0]).toEqual("p1"));
  });
});
