import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "./render.js";
import { App } from "../src/App.js";

// App now mounts useEvents() -> startEvents(), which would otherwise reach for a real EventSource
// (jsdom has none). Stub it to a no-op so this shell test stays hermetic; events.ts's own behavior
// is covered by test/events.test.ts and test/hooks.test.tsx.
vi.mock("../src/api/events.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/api/events.js")>();
  return { ...mod, startEvents: vi.fn(() => () => {}) };
});

describe("App shell", () => {
  it("renders the brand and global nav", () => {
    renderApp(<App />);
    // Brand renders as "◆ DevDB" (diamond mark + label in one text node), so match the label as a
    // substring — mirrors the regex queries used for the nav links below. (App.tsx's ◆ is verbatim
    // per the brief; the brief's exact-string getByText("DevDB") could never match that node.)
    expect(screen.getByText(/DevDB/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });

  it("renders the SSE connection dot", () => {
    renderApp(<App />);
    expect(screen.getByTestId("conn-dot")).toBeInTheDocument();
  });
});
