import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { useLocation } from "react-router";
import { makeQueryClient, renderApp } from "./render.js";

// Contract test for the shared test harness (test/render.tsx): tasks 7-13 build on both
// makeQueryClient's deterministic query defaults and renderApp's route honoring, so pin both
// behaviors here rather than rediscovering them per-task. Plain .ts (not .tsx), so the probe
// component is built with createElement instead of JSX.

describe("makeQueryClient", () => {
  it("disables retry so failed queries settle deterministically in tests", () => {
    const client = makeQueryClient();
    expect(client.getDefaultOptions().queries?.retry).toBe(false);
  });
});

describe("renderApp", () => {
  it("honors the route option via useLocation", () => {
    function LocationProbe() {
      const location = useLocation();
      return createElement("div", { "data-testid": "path" }, location.pathname);
    }
    renderApp(createElement(LocationProbe), { route: "/projects/p1" });
    expect(screen.getByTestId("path")).toHaveTextContent("/projects/p1");
  });
});
