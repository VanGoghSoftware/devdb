import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderApp } from "./render.js";
import { ProjectPage } from "../src/pages/ProjectPage.js";

vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: {
    status: vi.fn(), projects: { list: vi.fn() },
    branches: { list: vi.fn(), get: vi.fn(), create: vi.fn(), delete: vi.fn(), rename: vi.fn(), start: vi.fn(), stop: vi.fn(), restore: vi.fn(), reset: vi.fn() },
  },
}));
import { api } from "../src/api/client.js";
import type { BranchDto } from "@devdb/shared";

const main: BranchDto = {
  id: "b-main", projectId: "p1", parentBranchId: null, name: "main", slug: "main-s", timelineId: "t".repeat(32),
  endpointStatus: "running", endpointError: null, port: 54301, connectionString: "postgresql://postgres:pw@localhost:54301/postgres",
  lastRecordLsn: null, logicalSizeBytes: null, createdBy: "api", context: null, ancestorLsn: null,
  createdAt: "1", updatedAt: "1",
};

function renderPage(route = "/projects/p1") {
  return renderApp(
    <Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes>,
    { route },
  );
}

beforeEach(() => vi.mocked(api.branches.list).mockResolvedValue([main]));

describe("ProjectPage", () => {
  it("renders the rails view by default with the view toggle", async () => {
    renderPage();
    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /rails/i })).toBeChecked();
  });
  it("toggle switches to the canvas slot", async () => {
    renderPage();
    await screen.findByText("main");
    await userEvent.click(screen.getByRole("radio", { name: /canvas/i }));
    expect(screen.getByTestId("canvas-placeholder")).toBeInTheDocument();
  });
  it("creates a branch through the modal (defaults parent to main)", async () => {
    vi.mocked(api.branches.create).mockResolvedValue({ ...main, id: "b2", name: "dev" });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /new branch/i }));
    // Mantine Modal content mounts after a RAF+200ms delay in jsdom (no layout engine to flip it
    // off the initial unmounted state synchronously) — findBy* (not getBy*) per the pattern
    // established in dashboard.test.tsx's analogous "New Project" modal.
    await userEvent.type(await screen.findByLabelText(/name/i), "dev");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(api.branches.create).toHaveBeenCalledWith("p1", { name: "dev", parentBranchId: "b-main" }));
  });
  it("selecting a branch writes ?branch= to the URL", async () => {
    renderPage();
    (await screen.findByText("main")).closest("[data-branch-row]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(window.location.search === "?branch=b-main" || document.querySelector("[data-selected-branch=b-main]")).toBeTruthy());
  });
});
