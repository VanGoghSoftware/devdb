import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
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
  jdbcUrl: "jdbc:postgresql://127.0.0.1:54301/postgres?user=postgres&password=pw&sslmode=disable",
  lastRecordLsn: null, logicalSizeBytes: null, createdBy: "api", context: null, ancestorLsn: null,
  createdAt: "1", updatedAt: "1",
};

// Fix 1 fixture: a child branch off main, so "Branch from here" on the child has a non-main
// parent to prove the modal submits (rather than the stale first-render default).
const child: BranchDto = {
  ...main, id: "b-child", parentBranchId: "b-main", name: "child", slug: "child-s",
  endpointStatus: "stopped", port: null, connectionString: null, jdbcUrl: null,
};

function renderPage(route = "/projects/p1") {
  return renderApp(
    <Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes>,
    { route },
  );
}

// Fix 5(b): a tiny probe mounted alongside ProjectPage inside the same <Routes> so we can read
// the MemoryRouter's live location.search from the DOM without reaching into router internals.
function renderPageWithLocationProbe(route = "/projects/p1") {
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="location-search">{location.search}</div>;
  }
  return renderApp(
    <Routes>
      <Route path="/projects/:projectId" element={<><ProjectPage /><LocationProbe /></>} />
    </Routes>,
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
  it("toggle switches to the React Flow canvas", async () => {
    renderPage();
    await screen.findByText("main");
    await userEvent.click(screen.getByRole("radio", { name: /canvas/i }));
    expect(document.querySelector(".react-flow")).toBeInTheDocument();
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

  // Fix 1 (real bug): NewBranchModal's `parent` state was seeded once via
  // `useState(defaultParentId ?? mainId)` and never reset, because the modal wrapper stays
  // mounted (only Mantine's own Modal toggles `opened`). Opening "Branch from here" on a NON-main
  // branch changes the `defaultParentId` prop, but the already-initialized `parent` state ignored
  // it — so Create always submitted `main`. This test drives that exact user path.
  it("Branch from here submits the clicked branch's id, not a stale/default parent", async () => {
    vi.mocked(api.branches.list).mockResolvedValue([main, child]);
    vi.mocked(api.branches.create).mockResolvedValue({ ...main, id: "b3", name: "grandchild", parentBranchId: "b-child" });
    renderPage();
    await screen.findByText("child");

    await userEvent.click(await screen.findByRole("button", { name: /actions for child/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /branch from here/i }));

    await userEvent.type(await screen.findByLabelText(/name/i), "grandchild");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      const call = vi.mocked(api.branches.create).mock.calls.at(-1);
      // api.branches.create(projectId, body) — body (2nd arg) carries parentBranchId.
      expect(call?.[0]).toBe("p1");
      expect(call?.[1]).toEqual({ name: "grandchild", parentBranchId: "b-child" });
    });
  });

  it("reopening + New branch after a Branch-from-here submit resets the parent to main and clears the name", async () => {
    vi.mocked(api.branches.list).mockResolvedValue([main, child]);
    vi.mocked(api.branches.create).mockResolvedValue({ ...main, id: "b3", name: "grandchild", parentBranchId: "b-child" });
    renderPage();
    await screen.findByText("child");

    // First: open "Branch from here" on the child and complete a create (mirrors the test above,
    // driving the modal into its "parent = child" state).
    await userEvent.click(await screen.findByRole("button", { name: /actions for child/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /branch from here/i }));
    await userEvent.type(await screen.findByLabelText(/name/i), "grandchild");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitForElementToBeRemoved(() => screen.queryByLabelText(/name/i));

    // Then: open the top-level "+ New branch" button — must show a FRESH modal: parent reset to
    // main (not left over as "child" from the previous open) and the name field cleared.
    await userEvent.click(await screen.findByRole("button", { name: /new branch/i }));
    expect(await screen.findByLabelText(/name/i)).toHaveValue("");
    expect(screen.getByRole("combobox", { name: /parent branch/i })).toHaveValue("main");

    vi.mocked(api.branches.create).mockResolvedValue({ ...main, id: "b4", name: "third" });
    await userEvent.type(screen.getByLabelText(/name/i), "third");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => {
      const call = vi.mocked(api.branches.create).mock.calls.at(-1);
      expect(call?.[0]).toBe("p1");
      expect(call?.[1]).toEqual({ name: "third", parentBranchId: "b-main" });
    });
  });

  // Fix 2: modal closes on success.
  it("closes the modal after a successful create", async () => {
    vi.mocked(api.branches.create).mockResolvedValue({ ...main, id: "b2", name: "dev" });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /new branch/i }));
    await userEvent.type(await screen.findByLabelText(/name/i), "dev");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument());
  });

  // Fix 2: empty-state hint.
  it("shows the empty-state hint when the project has no branches", async () => {
    vi.mocked(api.branches.list).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/no branches yet/i)).toBeInTheDocument();
    expect(screen.getByText(/localhost:4400\/mcp/)).toBeInTheDocument();
  });

  // Fix 2: error state. Moved to test/project-page-error.test.tsx — see that file's header
  // comment for why this specific case can't live in this file (a root-caused vitest/jsdom/React
  // Query interaction with this file's shared beforeEach, not a bug in the app or the assertions).

  // Fix 5: was `window.location.search === "?branch=b-main" || document.querySelector(...)` — a
  // disjunct weak enough to pass even if only ONE side of the round-trip worked (e.g. if the
  // `data-selected-branch` attribute were wired from a local click handler instead of genuinely
  // reading back the router's own search params, this would still go green). Replaced with two
  // targeted assertions: (a) reading the selection back out of a real router location.search via
  // a mounted useLocation() probe (proves the write actually reached the router, not just a
  // component-local variable), and (b) a separate test proving the read path on initial load.
  it("selecting a branch writes ?branch= to the URL, provably via the router's own location", async () => {
    const { container } = renderPageWithLocationProbe();
    expect(screen.getByTestId("location-search")).toHaveTextContent("");
    (await screen.findByText("main")).closest("[data-branch-row]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent("?branch=b-main"));
    expect(container.querySelector("[data-selected-branch=b-main]")).toBeTruthy();
  });

  // Fix 5: selection state is READ from the URL on load, not just written to it — proves the
  // symmetric other half of the round-trip (a page refresh / shared link with ?branch= must
  // restore the selection, not just a same-session click).
  it("reads the selected branch from the URL on initial load", async () => {
    renderPageWithLocationProbe("/projects/p1?branch=b-main");
    await screen.findByText("main");
    expect(document.querySelector("[data-selected-branch=b-main]")).toBeTruthy();
  });
});
