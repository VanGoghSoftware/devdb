import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render.js";
import { PgBuildsCard } from "../src/settings/PgBuildsCard.js";

vi.mock("../src/api/client.js", () => ({
  // Match the real ApiError shape (status + message) so the downgrade-409 path is exercisable.
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
  api: {
    status: vi.fn(),
    projects: {}, branches: {},
    pgBuilds: {
      list: vi.fn(),
      check: vi.fn(),
      pull: vi.fn(),
      activate: vi.fn(),
      remove: vi.fn(),
    },
  },
}));
import { api, ApiError } from "../src/api/client.js";
import type { PgBuildDto, StatusDto } from "@devdb/shared";

// FULLY-typed fixtures (repo rule: no `as any`/`as never`, tests included).
const baseStatus: StatusDto = {
  version: "0.1.0", healthy: true, engine: {}, portRange: { min: 54300, max: 54339 }, storage: "none",
  pgBuilds: {
    "16": { activeVersion: "16.10", source: "downloaded", degradedDowngrade: false, updateAvailable: null },
    "17": { activeVersion: "17.5", source: "baked", degradedDowngrade: false, updateAvailable: null },
  },
};

function build(overrides: Partial<PgBuildDto>): PgBuildDto {
  return {
    id: "build-1", major: 16, minor: 10, version: "16.10", source: "downloaded",
    releaseTag: "16.10", imageDigest: "sha256:abc", status: "ready", active: true,
    inUse: false, sizeBytes: 123, error: null, createdAt: "2026-07-03T00:00:00Z",
    ...overrides,
  };
}

const builds: PgBuildDto[] = [
  build({ id: "b16-10", major: 16, minor: 10, version: "16.10", active: true, inUse: true }),
  build({ id: "b16-9", major: 16, minor: 9, version: "16.9", active: false, inUse: false, releaseTag: "16.9" }),
  build({
    id: "b17-5", major: 17, minor: 5, version: "17.5", source: "baked", releaseTag: "17.5",
    imageDigest: "", active: true, inUse: true,
  }),
];

// Fix round 1: the exact post-resolveActives scenario the review flagged — a baked build for a
// major that ALSO has a downloaded build demoted to non-active, non-inUse the moment that
// downloaded build activates. It's "ready" and looks just like any other deletable row, but the
// daemon's assertRemovable (registry.ts) 409s ANY source:"baked" row unconditionally, regardless
// of active/inUse. major 18 is otherwise unused by any other test in this file/major list.
const bakedNonActiveBuild = build({
  id: "b18-3", major: 18, minor: 3, version: "18.3", source: "baked", releaseTag: "18.3",
  imageDigest: "", active: false, inUse: false,
});
const buildsWithBakedNonActive: PgBuildDto[] = [...builds, bakedNonActiveBuild];
const statusWithMajor18: StatusDto = {
  ...baseStatus,
  pgBuilds: {
    ...baseStatus.pgBuilds,
    "18": { activeVersion: "18.4", source: "downloaded", degradedDowngrade: false, updateAvailable: null },
  },
};

beforeEach(() => {
  vi.mocked(api.status).mockResolvedValue(baseStatus);
  vi.mocked(api.pgBuilds.list).mockResolvedValue(builds);
  vi.mocked(api.pgBuilds.check).mockReset();
  vi.mocked(api.pgBuilds.pull).mockReset();
  vi.mocked(api.pgBuilds.activate).mockReset();
  vi.mocked(api.pgBuilds.remove).mockReset();
});

describe("PgBuildsCard", () => {
  it("renders one section per major (ascending) with the active chip from status", async () => {
    renderApp(<PgBuildsCard />);
    const heading16 = await screen.findByText("PG 16");
    const heading17 = await screen.findByText("PG 17");
    // Ascending order: PG 16's heading precedes PG 17's in document order.
    expect(heading16.compareDocumentPosition(heading17) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // "16.10" legitimately appears twice for major 16 — the header's active chip AND the
    // installed-list row for the same (active) build — so assert presence via count, not identity.
    expect(screen.getAllByText(/16\.10/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/downloaded/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/17\.5/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/baked/).length).toBeGreaterThanOrEqual(2);
  });

  it("shows the orange degraded alert only for a major with degradedDowngrade", async () => {
    vi.mocked(api.status).mockResolvedValue({
      ...baseStatus,
      pgBuilds: {
        ...baseStatus.pgBuilds,
        "16": { ...baseStatus.pgBuilds["16"]!, degradedDowngrade: true },
      },
    });
    renderApp(<PgBuildsCard />);
    await screen.findByText("PG 16");
    const alert = await screen.findByText(/running below the last-used minor/i);
    expect(alert).toBeInTheDocument();
    // PG 17 is not degraded — only one alert renders.
    expect(screen.getAllByText(/running below the last-used minor/i)).toHaveLength(1);
  });

  it("Check for updates shows an update-available badge and Pull button after resolving, and Pull posts the right body", async () => {
    vi.mocked(api.pgBuilds.check).mockResolvedValue({
      "16": { tag: "16.11", digest: "sha256:new", isNew: true },
      "17": { tag: "17.5", digest: "sha256:old", isNew: false },
    });
    vi.mocked(api.pgBuilds.pull).mockResolvedValue({ buildId: "b16-11" });
    renderApp(<PgBuildsCard />);
    await screen.findByText("PG 16");

    const checkButton = screen.getByRole("button", { name: /check for updates/i });
    await userEvent.click(checkButton);

    expect(await screen.findByText(/update available/i)).toBeInTheDocument();
    // Only PG 16 got isNew:true, so exactly one Pull-by-header button should appear from the check.
    const pullButtons = await screen.findAllByRole("button", { name: /^pull$/i });
    expect(pullButtons).toHaveLength(1);

    await userEvent.click(pullButtons[0]!);
    // TanStack Query v5's mutationFn(variables, context) 2-arg shape (same as dashboard.test.tsx's
    // create/delete assertions) — assert on the call's first argument only.
    await waitFor(() => expect(vi.mocked(api.pgBuilds.pull).mock.calls.at(-1)?.[0]).toEqual({ major: 16 }));
  });

  it("Activate on a lower minor confirms via window.confirm and sends consented:true only when confirmed", async () => {
    vi.mocked(api.pgBuilds.activate).mockResolvedValue(build({ id: "b16-9", major: 16, minor: 9, active: true }));
    renderApp(<PgBuildsCard />);
    await screen.findByText("PG 16");

    const confirmSpy = vi.spyOn(window, "confirm");
    const activateButtons = await screen.findAllByRole("button", { name: /^activate$/i });
    // Exactly one Activate button for major 16 (16.9, the non-active row); 16.10 is active (hidden)
    // and 17.5 is the only (active) row for major 17.
    expect(activateButtons).toHaveLength(1);

    confirmSpy.mockReturnValueOnce(false);
    await userEvent.click(activateButtons[0]!);
    expect(api.pgBuilds.activate).not.toHaveBeenCalled();
    expect(confirmSpy).toHaveBeenLastCalledWith(
      "Activating 16.9 is a downgrade below 16.10. The neon extension's catalog upgrades forward-only. Continue?",
    );

    confirmSpy.mockReturnValueOnce(true);
    await userEvent.click(activateButtons[0]!);
    // TanStack Query v5 calls mutationFn(variables, context) — api.pgBuilds.activate here IS the
    // mutationFn's own implementation (useActivatePgBuild wraps it, but the wrapper itself is what
    // TanStack invokes with the extra context arg, and the wrapper forwards a.id/a.consented
    // positionally) so only the first TWO args (id, consented) are the real call; nothing extra
    // should leak onto api.pgBuilds.activate itself since the wrapper calls it with exactly 2 args.
    await waitFor(() =>
      expect(vi.mocked(api.pgBuilds.activate).mock.calls.at(-1)).toEqual(["b16-9", true]),
    );
  });

  it("Delete is disabled (with a tooltip) when the row is active or inUse", async () => {
    renderApp(<PgBuildsCard />);
    await screen.findByText("PG 16");

    const deleteButtons = await screen.findAllByRole("button", { name: /^delete$/i });
    // Rows present: b16-10 (active+inUse, hence no Activate but yes Delete-disabled), b16-9
    // (downloaded, not active/inUse -> Delete enabled), b17-5 (baked, active+inUse -> disabled).
    const activeRowDeleteButton = deleteButtons.find((b) => b.hasAttribute("disabled"));
    expect(activeRowDeleteButton).toBeDefined();
    expect(activeRowDeleteButton).toBeDisabled();

    const enabledDeleteButton = deleteButtons.find((b) => !b.hasAttribute("disabled"));
    expect(enabledDeleteButton).toBeDefined();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.pgBuilds.remove).mockResolvedValue(undefined);
    await userEvent.click(enabledDeleteButton!);
    expect(confirmSpy).toHaveBeenCalled();
    // useDeletePgBuild passes api.pgBuilds.remove directly as mutationFn, so TanStack's own
    // mutationFn(variables, context) 2-arg call shape lands the context object on THIS mock
    // directly (same leak dashboard.test.tsx documents for api.projects.delete) — assert the
    // first argument only.
    await waitFor(() => expect(vi.mocked(api.pgBuilds.remove).mock.calls.at(-1)?.[0]).toEqual("b16-9"));
  });

  // Fix round 1 (Important): assertRemovable 409s ANY baked row unconditionally, but a baked
  // build for a major with an active downloaded build is non-active/non-inUse — the pre-fix
  // deleteDisabled (row.active || row.inUse) left its Delete button enabled, so clicking it
  // always 409s. This is a rendering assertion, independent of the click-to-409 path (the daemon
  // side of that path already has its own coverage in registry.test.ts); it should fail against
  // pre-fix code (baked non-active row's Delete would come back ENABLED).
  it("Delete is disabled for a baked build even when it is not the active/inUse row", async () => {
    vi.mocked(api.status).mockResolvedValue(statusWithMajor18);
    vi.mocked(api.pgBuilds.list).mockResolvedValue(buildsWithBakedNonActive);
    renderApp(<PgBuildsCard />);
    await screen.findByText("PG 18");

    const bakedRow = screen.getByText(/18\.3 · baked · ready/i).closest("div");
    expect(bakedRow).not.toBeNull();
    const bakedDeleteButton = within(bakedRow as HTMLElement).getByRole("button", { name: /^delete$/i });
    expect(bakedDeleteButton).toBeDisabled();
  });

  // Fix round 2 (P4): a disabled Mantine Button doesn't emit the hover/focus events Tooltip
  // relies on to open (Tooltip.mjs clones its reference props — onMouseEnter/onPointerEnter/etc
  // — directly onto its single child), so wrapping the bare disabled Button leaves the
  // explanatory tooltip unreachable. Mantine's documented fix is to give Tooltip a non-disabled
  // wrapper as its direct child instead, so the WRAPPER — not the inert control — is what
  // receives those props; the Button inside stays functionally disabled (no click-through).
  // Hover-in-jsdom is flaky (see render.tsx's Popover hideDetached note), so this asserts the
  // STRUCTURAL fix rather than the resulting hover behavior.
  //
  // Discriminator (confirmed by probing the actual pre-fix DOM): today the disabled Delete
  // Button's parentElement IS the surrounding Mantine `Group` (a <div class="...mantine-Group-
  // root...">) — Tooltip clones its reference props straight onto the Button with no intervening
  // node. Once the fix wraps the Button in something else (e.g. a <span> Box) for Tooltip to
  // target, an extra element sits between the Button and that Group, so the Button's immediate
  // parent is no longer the Group itself. Fails pre-fix; passes for any wrapper element choice.
  it("the disabled Delete button is not a direct child of the Group — a wrapper sits between it and Tooltip", async () => {
    renderApp(<PgBuildsCard />);
    await screen.findByText("PG 16");

    const deleteButtons = await screen.findAllByRole("button", { name: /^delete$/i });
    const disabledDelete = deleteButtons.find((b) => b.hasAttribute("disabled"));
    expect(disabledDelete).toBeDefined();
    const parent = disabledDelete!.parentElement;
    expect(parent).not.toBeNull();
    expect(parent!.className).not.toMatch(/mantine-Group-root/);
  });

  // #8: the card derived its major sections from status.pgBuilds (ready majors only) — an in-flight
  // NEW-major pull has a row in usePgBuilds() but no status.pgBuilds entry yet, so it was invisible.
  // Union both sources (same class ec0027a fixed for the MCP list tool).
  it("renders a section for an in-flight NEW major present only in the builds list (not yet in status.pgBuilds)", async () => {
    vi.mocked(api.pgBuilds.list).mockResolvedValue([
      ...builds,
      build({ id: "b18-dl", major: 18, minor: null, version: null, status: "downloading", active: false, inUse: false, releaseTag: "9999" }),
    ]);
    renderApp(<PgBuildsCard />);
    expect(await screen.findByText("PG 18")).toBeInTheDocument();
  });

  // #8: the update-available badge rendered only the component-local Check result and ignored the
  // server's persisted status.pgBuilds[m].updateAvailable — so it vanished on reload. Fall back to it.
  it("shows the update-available badge from the server's persisted status field, without a local Check", async () => {
    vi.mocked(api.status).mockResolvedValue({
      ...baseStatus,
      pgBuilds: {
        ...baseStatus.pgBuilds,
        "16": { ...baseStatus.pgBuilds["16"]!, updateAvailable: "16.11" },
      },
    });
    renderApp(<PgBuildsCard />);
    await screen.findByText("PG 16");
    expect(await screen.findByText(/update available/i)).toBeInTheDocument();
  });

  // #7: the local heuristic flags a downgrade vs the ACTIVE minor, but the daemon guards against the
  // last-run HIGH-WATER. In a degraded major (active < high-water), a target the heuristic thinks is
  // safe still 409s — the UI had no consent path. Catch the 409-downgrade and confirm-retry.
  // major 16 here is DEGRADED: active 16.8, but 16.10 already ran (high-water). Activating 16.9 is
  // NOT a local downgrade (9 >= 8) so it goes out un-consented; the daemon 409s (9 < 10).
  const degradedMajor16 = {
    ...baseStatus,
    pgBuilds: { ...baseStatus.pgBuilds, "16": { activeVersion: "16.8", source: "downloaded" as const, degradedDowngrade: true, updateAvailable: null } },
  };
  const degradedBuilds16: PgBuildDto[] = [
    build({ id: "b16-8", major: 16, minor: 8, version: "16.8", active: true, inUse: true, releaseTag: "16.8" }),
    build({ id: "b16-9", major: 16, minor: 9, version: "16.9", active: false, inUse: false, releaseTag: "16.9" }),
  ];

  it("consent-retries an Activate the daemon 409s as a downgrade (the degraded case the local heuristic misses)", async () => {
    vi.mocked(api.status).mockResolvedValue(degradedMajor16);
    vi.mocked(api.pgBuilds.list).mockResolvedValue(degradedBuilds16);
    vi.mocked(api.pgBuilds.activate)
      .mockRejectedValueOnce(new ApiError(409, "activating 16.9 would downgrade below the last-run 16.10 — pass consented:true"))
      .mockResolvedValue(build({ id: "b16-9", major: 16, minor: 9, active: true }));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp(<PgBuildsCard />);
    await screen.findByText("PG 16");
    const activateButtons = await screen.findAllByRole("button", { name: /^activate$/i });
    await userEvent.click(activateButtons[0]!); // b16-9: minor 9 >= active 8, so NOT a local downgrade

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(api.pgBuilds.activate).mock.calls.at(-1)).toEqual(["b16-9", true]));
    expect(vi.mocked(api.pgBuilds.activate).mock.calls).toHaveLength(2);
  });

  it("does NOT retry the Activate when the user declines the downgrade confirm", async () => {
    vi.mocked(api.status).mockResolvedValue(degradedMajor16);
    vi.mocked(api.pgBuilds.list).mockResolvedValue(degradedBuilds16);
    vi.mocked(api.pgBuilds.activate).mockRejectedValueOnce(new ApiError(409, "would downgrade below the last-run 16.10"));
    vi.spyOn(window, "confirm").mockReturnValue(false);

    renderApp(<PgBuildsCard />);
    await screen.findByText("PG 16");
    const activateButtons = await screen.findAllByRole("button", { name: /^activate$/i });
    await userEvent.click(activateButtons[0]!);

    await waitFor(() => expect(vi.mocked(api.pgBuilds.activate).mock.calls).toHaveLength(1)); // no consented retry
  });
});
