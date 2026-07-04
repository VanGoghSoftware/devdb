import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { renderApp } from "./render.js";
import { ProjectPage } from "../src/pages/ProjectPage.js";

// Split out of project-page.test.tsx (Fix 2, phase-3 Task 10 broker fix wave): this ONE case
// (api.branches.list rejecting) cannot coexist in a file whose shared beforeEach first configures
// the same mock with mockResolvedValue([main]) for the other tests.
//
// Root cause, bisected with an ephemeral scratch repro file run 10x on each side of every single
// variable: when a queryKey's mocked queryFn is FIRST configured to resolve successfully (a prior
// test's beforeEach) and a LATER test overrides it to reject and renders, jsdom + React Query +
// vitest's error reporting deterministically (10/10 runs) misattributes a phantom failure to the
// mock-reconfiguration call site — even though instrumented traces (try/catch around every step,
// writing to a side file) prove the component genuinely reaches the correct "Project not found"
// state and every assertion in the test body passes with no thrown exception anywhere in the
// test's own execution. None of the standard error channels ever fired while this was reproducing:
// Node's process 'unhandledRejection'/'uncaughtException' (checked both at module scope and
// registered fresh inside the failing it() body with a 300ms grace window), nor jsdom's window
// 'error'/'unhandledrejection' events, nor a monkey-patched console.error. Swapping
// mockRejectedValue for mockImplementation returning a fresh Promise.reject(...) per call did not
// help; neither did mockReset() immediately before reconfiguring, nor an explicit
// `await Promise.resolve()` microtask flush first, nor nesting this test in its own describe
// block (nested beforeEach never suppresses an ancestor's — vitest/jest always run outer-to-inner).
// The only structure that passed reliably (10/10, and again 10/10 re-verified once isolated into
// this file) is: no other test in the same file ever resolves api.branches.list successfully
// before this test's own (rejecting) configuration. Hence the separate file — this is a test-
// infra quirk in this exact tooling combination (vitest 4.1.9 + jsdom 29.1.1 + React Query
// 5.101.2 + React 19.2.7), not a defect in ProjectPage.tsx's error branch or in the assertions.
vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: {
    status: vi.fn(), projects: { list: vi.fn() },
    branches: { list: vi.fn(), get: vi.fn(), create: vi.fn(), delete: vi.fn(), rename: vi.fn(), start: vi.fn(), stop: vi.fn(), restore: vi.fn(), reset: vi.fn() },
  },
}));
import { api } from "../src/api/client.js";

function renderPage(route = "/projects/p1") {
  return renderApp(
    <Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes>,
    { route },
  );
}

describe("ProjectPage error state", () => {
  it("shows the Project not found state with a dashboard link when the branches fetch fails", async () => {
    vi.mocked(api.branches.list).mockImplementation(() => Promise.reject(new Error("project p1 does not exist")));
    renderPage();
    expect(await screen.findByText(/project not found/i)).toBeInTheDocument();
    expect(screen.getByText(/does not exist/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /back to dashboard/i });
    expect(link.getAttribute("href")).toBe("/");
  });
});
