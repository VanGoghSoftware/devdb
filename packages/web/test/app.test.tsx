import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "./render.js";
import { App } from "../src/App.js";

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
});
