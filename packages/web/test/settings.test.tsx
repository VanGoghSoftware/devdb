import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMantineColorScheme } from "@mantine/core";
import { renderApp } from "./render.js";
import { SettingsPage } from "../src/pages/SettingsPage.js";
import { getDefaultTreeView } from "../src/prefs.js";

vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: {
    status: vi.fn().mockResolvedValue({
      version: "0.1.0", healthy: true, engine: {}, portRange: { min: 54300, max: 54339 }, storage: "none",
    }),
    projects: {}, branches: {},
  },
}));

beforeEach(() => localStorage.clear());

describe("SettingsPage", () => {
  it("shows read-only daemon facts", async () => {
    renderApp(<SettingsPage />);
    expect(await screen.findByText(/54300\s*–\s*54339/)).toBeInTheDocument();
    expect(screen.getByText(/local \(none\)/i)).toBeInTheDocument();
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
  });

  it("changes the default tree view preference in localStorage", async () => {
    renderApp(<SettingsPage />);
    await userEvent.click(await screen.findByRole("radio", { name: /canvas/i }));
    expect(getDefaultTreeView()).toBe("canvas");
  });

  // The single source of truth for the LIVE color scheme is Mantine's own context (main.tsx
  // wires its manager to the "devdb.theme" localStorage key) — so the theme control must drive it
  // via useMantineColorScheme().setColorScheme, not via a raw prefs.ts setThemePref() write (which
  // Mantine's context wouldn't observe until a reload). We prove that by mounting a second,
  // independent consumer of useMantineColorScheme() alongside SettingsPage: if — and only if —
  // Settings calls the real setColorScheme, this probe's live `colorScheme` reactively flips.
  // A raw localStorage.setItem (what setThemePref alone does) would leave this probe unchanged.
  function ColorSchemeProbe() {
    const { colorScheme } = useMantineColorScheme();
    return <div data-testid="live-color-scheme">{colorScheme}</div>;
  }

  it("drives the LIVE Mantine color scheme via setColorScheme when the theme control is changed", async () => {
    renderApp(
      <>
        <SettingsPage />
        <ColorSchemeProbe />
      </>,
    );
    await screen.findByText(/54300\s*–\s*54339/);
    // Baseline is whatever MantineProvider's own default is in this harness (render.tsx passes no
    // defaultColorScheme, so Mantine's "light") — the point of this test is the CHANGE below, not
    // pinning that default, which belongs to render.tsx/Mantine rather than SettingsPage.
    const before = screen.getByTestId("live-color-scheme").textContent;
    expect(before).not.toBe("dark");
    await userEvent.click(screen.getByRole("radio", { name: /^dark$/i }));
    expect(screen.getByTestId("live-color-scheme")).toHaveTextContent("dark");
  });

  // Design spec (§Screens/Settings) names both stubs explicitly: "disabled phase-4 stubs (Remote
  // storage, Export targets)" — two cards, not one.
  it("renders the phase-4 stubs disabled", async () => {
    renderApp(<SettingsPage />);
    expect(await screen.findByText(/remote storage/i)).toBeInTheDocument();
    expect(screen.getByText(/export targets/i)).toBeInTheDocument();
    expect(screen.getAllByText(/coming in phase 4/i).length).toBeGreaterThanOrEqual(2);
  });

  // Daemon facts (version, port range, durability) are plain <Text>, not inputs/buttons — there is
  // no affordance to edit them from the client, matching "read-only" in the task brief.
  it("renders daemon facts as plain text with no editable control", async () => {
    renderApp(<SettingsPage />);
    const versionText = await screen.findByText("0.1.0");
    expect(versionText.closest("input, button, [contenteditable=true]")).toBeNull();
  });
});
