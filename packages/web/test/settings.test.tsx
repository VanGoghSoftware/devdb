import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, useMantineColorScheme } from "@mantine/core";
import { renderApp } from "./render.js";
import { SettingsPage } from "../src/pages/SettingsPage.js";
import { getDefaultTreeView } from "../src/prefs.js";

vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: {
    status: vi.fn().mockResolvedValue({
      version: "0.1.0", healthy: true, engine: {}, portRange: { min: 54300, max: 54339 }, storage: "none", pgBuilds: {},
    }),
    projects: {}, branches: {},
  },
}));
import { api } from "../src/api/client.js";

beforeEach(() => localStorage.clear());

describe("SettingsPage", () => {
  it("shows read-only daemon facts", async () => {
    renderApp(<SettingsPage />);
    expect(await screen.findByText(/54300\s*–\s*54339/)).toBeInTheDocument();
    expect(screen.getByText(/^local$/i)).toBeInTheDocument();
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
  });

  // Fix 3 (P4): storage: "none" must render the bare label "local", not the self-contradicting
  // "local (none)" — and for a future non-"none" mode (s3/azure), the label must be the mode name
  // itself, not "local (s3)" (which asserts the daemon is BOTH local and remote at once).
  it("shows the storage mode name directly for a non-none storage mode, not 'local (mode)'", async () => {
    vi.mocked(api.status).mockResolvedValue({
      version: "0.1.0", healthy: true, engine: {}, portRange: { min: 54300, max: 54339 }, storage: "s3", pgBuilds: {},
    });
    renderApp(<SettingsPage />);
    expect(await screen.findByText(/^s3$/i)).toBeInTheDocument();
    expect(screen.queryByText(/local/i)).not.toBeInTheDocument();
  });

  it("changes the default tree view preference in localStorage", async () => {
    renderApp(<SettingsPage />);
    await userEvent.click(await screen.findByRole("radio", { name: /canvas/i }));
    expect(getDefaultTreeView()).toBe("canvas");
  });

  // The single source of truth for the LIVE color scheme is Mantine's own context (main.tsx
  // wires its manager to prefs.ts's THEME_STORAGE_KEY) — so the theme control must both READ and
  // WRITE through useMantineColorScheme(), not a locally-seeded useState (which would go stale the
  // moment any OTHER consumer changes the scheme while Settings stays mounted) and not a raw
  // prefs.ts setThemePref() write (which Mantine's context wouldn't observe until a reload). We
  // prove both directions by mounting a second, independent consumer of useMantineColorScheme()
  // alongside SettingsPage:
  //  - write direction: only if Settings calls the real setColorScheme does this probe's live
  //    `colorScheme` reactively flip (a raw localStorage.setItem, what setThemePref alone does,
  //    would leave the probe unchanged).
  //  - read direction: only if Settings' SegmentedControl value is bound to the live colorScheme
  //    (not a seeded-once local copy) does an EXTERNAL change made via this second consumer show
  //    up as the checked radio in Settings' own control.
  function ColorSchemeProbe() {
    const { colorScheme } = useMantineColorScheme();
    return <div data-testid="live-color-scheme">{colorScheme}</div>;
  }
  function ColorSchemeSetter() {
    const { setColorScheme } = useMantineColorScheme();
    return <Button onClick={() => setColorScheme("dark")}>external-set-dark</Button>;
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

  it("reflects a scheme change made by a different consumer in the Settings control's shown value", async () => {
    renderApp(
      <>
        <SettingsPage />
        <ColorSchemeSetter />
      </>,
    );
    await screen.findByText(/54300\s*–\s*54339/);
    expect(screen.getByRole("radio", { name: /^dark$/i })).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "external-set-dark" }));
    expect(screen.getByRole("radio", { name: /^dark$/i })).toBeChecked();
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
