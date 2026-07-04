import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render.js";
import { PgBuildsCard } from "../src/settings/PgBuildsCard.js";

vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
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
import { api } from "../src/api/client.js";
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
});
