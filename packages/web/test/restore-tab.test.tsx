import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render.js";
import { RestoreTab } from "../src/drawer/RestoreTab.js";

// Duplicated verbatim from drawer.test.tsx: vi.mock factories are hoisted per-file and cannot be
// imported from a shared helper, so both the mock block and the typed BranchDto fixture live here too.
vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: {
    status: vi.fn(), projects: {},
    branches: { get: vi.fn(), rename: vi.fn(), delete: vi.fn(), reset: vi.fn(), start: vi.fn(), stop: vi.fn(), restore: vi.fn(), list: vi.fn(), create: vi.fn() },
  },
}));
import { api } from "../src/api/client.js";
import type { BranchDto } from "@devdb/shared";

const branch: BranchDto = {
  id: "b1", projectId: "p1", parentBranchId: "b-main", name: "agent-fix", slug: "agent-fix-s",
  timelineId: "t".repeat(32), endpointStatus: "running", endpointError: null, port: 54303,
  connectionString: "postgresql://postgres:S3CRET@localhost:54303/postgres",
  lastRecordLsn: "0/169AD58", logicalSizeBytes: 24117248, createdBy: "mcp",
  context: { agent: "claude", git_branch: "fix-1", purpose: "repro the bug" },
  ancestorLsn: "0/1690000", createdAt: "2026-07-03T10:00:00Z", updatedAt: "2026-07-03T10:00:00Z",
  runningPgVersion: null,
};

// `shouldAdvanceTime: true` (used below) is required for userEvent's internal delays to resolve
// at all under fake timers — a plain vi.useFakeTimers() hangs userEvent.click indefinitely
// (verified directly: Date.now() never advances past the frozen instant, so userEvent's own
// internal wait-for-idle never observes progress). That mode's tradeoff is real, bounded
// wall-clock drift ticking the fake clock forward between setSystemTime and the moment a chip's
// onChange reads Date.now() — observed ~40-150ms per prior interaction in this suite. Assert the
// preset math within a tolerance window instead of a bit-exact string, so the test proves "N
// minutes back from now" without being brittle to that drift.
const DRIFT_TOLERANCE_MS = 2000;
function assertCloseIso(actual: string, expectedIso: string): void {
  const diff = Math.abs(new Date(actual).getTime() - new Date(expectedIso).getTime());
  expect(diff).toBeLessThan(DRIFT_TOLERANCE_MS);
}

describe("RestoreTab", () => {
  // Explicit useRealTimers afterEach (events.test.ts's own convention) keeps this file's
  // fake-timer state from bleeding into whichever test file runs next in the same worker.
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }).setSystemTime(new Date("2026-07-03T12:00:00Z")));
  afterEach(() => vi.useRealTimers());

  it("as-new-branch: preset 30 m builds an ISO timestamp 30 minutes back and posts new_branch mode", async () => {
    vi.mocked(api.branches.restore).mockResolvedValue(branch);
    renderApp(<RestoreTab branch={branch} />);
    await userEvent.click(screen.getByRole("radio", { name: /as a new branch/i }));
    await userEvent.click(screen.getByRole("checkbox", { name: /30 m/i }));
    await userEvent.type(screen.getByLabelText(/new branch name/i), "before-mistake");
    await userEvent.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(api.branches.restore).toHaveBeenCalled());
    // TanStack Query v5's mutationFn(variables) shape — assert on the call's actual argument
    // (drawer.test.tsx's established `.mock.calls.at(-1)?.[0]` convention) rather than a full
    // toHaveBeenCalledWith, since `to` needs tolerance-based comparison, not exact-string equality.
    const [id, body] = vi.mocked(api.branches.restore).mock.calls.at(-1) ?? [];
    expect(id).toBe("b1");
    expect(body).toMatchObject({ mode: "new_branch", name: "before-mistake" });
    assertCloseIso(body!.to, "2026-07-03T11:30:00.000Z");
  });

  it("in-place shows the auto-stop notice and posts in_place mode", async () => {
    vi.mocked(api.branches.restore).mockResolvedValue(branch);
    renderApp(<RestoreTab branch={branch} />);
    expect(screen.getByText(/endpoint will be stopped/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /5 m/i }));
    await userEvent.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(api.branches.restore).toHaveBeenCalled());
    const [id, body] = vi.mocked(api.branches.restore).mock.calls.at(-1) ?? [];
    expect(id).toBe("b1");
    expect(body).toMatchObject({ mode: "in_place" });
    assertCloseIso(body!.to, "2026-07-03T11:55:00.000Z");
  });

  // Fix 3 (P4 / reviewer Minor): with no timestamp chosen at all (neither a preset nor a custom
  // value), the Restore button is the tab's only guard against submitting an empty `to` — it must
  // stay disabled from first render, in either mode, not just "until you touch something".
  it("Restore is disabled with no timestamp selected (default in_place mode)", () => {
    renderApp(<RestoreTab branch={branch} />);
    expect(screen.getByRole("button", { name: /restore/i })).toBeDisabled();
  });

  // Fix 3 (P4 / reviewer Minor): `new_branch` mode adds a second, independent guard (a non-blank
  // name) on top of the timestamp guard — both must hold. This proves the button starts disabled
  // even with a valid timestamp already selected (name still blank), then becomes enabled only once
  // a non-blank name is also present.
  it("new_branch mode: Restore stays disabled with a blank name, enables only once a name is entered", async () => {
    renderApp(<RestoreTab branch={branch} />);
    await userEvent.click(screen.getByRole("radio", { name: /as a new branch/i }));
    await userEvent.click(screen.getByRole("checkbox", { name: /30 m/i }));
    // Timestamp is now set, but the name field is still blank — button must stay disabled.
    expect(screen.getByRole("button", { name: /restore/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/new branch name/i), "before-mistake");
    expect(screen.getByRole("button", { name: /restore/i })).toBeEnabled();
  });

  // Fix 3 (P4 / reviewer Minor): the `datetime-local` custom-timestamp input is the OTHER way to
  // pick a restore point (mutually exclusive with the preset Chips via shared `selectedPreset` /
  // `customLocal` state) — this exercises that path specifically, which none of the tests above
  // touch (they only use preset Chips). Asserts both halves of the mutual-exclusion contract: (i)
  // picking a custom value clears any previously-selected preset's checked state, and (ii) the
  // custom value's ISO conversion is what actually lands in the mutate call's `to` field.
  it("custom datetime-local input clears any selected preset and posts its own ISO `to`", async () => {
    vi.mocked(api.branches.restore).mockResolvedValue(branch);
    renderApp(<RestoreTab branch={branch} />);

    // First select a preset, to prove the custom input below actually clears it (not just that no
    // preset was ever selected in the first place).
    await userEvent.click(screen.getByRole("checkbox", { name: /1 h/i }));
    expect(screen.getByRole("checkbox", { name: /1 h/i })).toBeChecked();

    // `fireEvent.change` (via `userEvent`'s underlying `type`/`clear` doesn't apply to
    // `datetime-local` inputs the way it does to text inputs in jsdom) — this component's own
    // `onChange={(e) => pickCustom(e.currentTarget.value)}` reads `e.currentTarget.value` directly,
    // so a plain fill of the raw value exercises the exact same code path a real browser's
    // datetime-local picker would trigger.
    const customInput = screen.getByLabelText(/custom timestamp/i);
    await userEvent.click(customInput);
    // jsdom's datetime-local input accepts the same value format the component's `new
    // Date(v).toISOString()` call expects (`YYYY-MM-DDTHH:mm`). A `datetime-local` value has no
    // timezone suffix, so `new Date(...)` parses it as LOCAL time (per the JS date-string spec) —
    // exactly what the component's own `pickCustom` does. Compute the expected ISO the same way
    // here, rather than a hardcoded literal, so this test isn't coupled to the runner's local TZ
    // (this repo's dev/CI machines are not guaranteed to share one — observed Europe/Amsterdam
    // locally, producing a UTC+2 offset from the literal value in July).
    const customLocalValue = "2026-07-01T09:30";
    const expectedIso = new Date(customLocalValue).toISOString();
    Object.defineProperty(customInput, "value", { value: customLocalValue, writable: true });
    customInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(screen.getByRole("checkbox", { name: /1 h/i })).not.toBeChecked();
    expect(screen.getByText(/restore point:/i)).toHaveTextContent(expectedIso);

    await userEvent.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(api.branches.restore).toHaveBeenCalled());
    const [, body] = vi.mocked(api.branches.restore).mock.calls.at(-1) ?? [];
    expect(body).toMatchObject({ mode: "in_place", to: expectedIso });
  });
});
