import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, makeQueryClient } from "./render.js";
import { BranchDrawer, maskConnstring } from "../src/drawer/BranchDrawer.js";
import { formatBytes } from "../src/drawer/InfoTab.js";
import { keys } from "../src/api/keys.js";

vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: {
    status: vi.fn(), projects: {},
    branches: { get: vi.fn(), rename: vi.fn(), delete: vi.fn(), reset: vi.fn(), start: vi.fn(), stop: vi.fn(), restore: vi.fn(), list: vi.fn(), create: vi.fn() },
  },
}));
import { api } from "../src/api/client.js";
import type { BranchDto, StatusDto } from "@devdb/shared";

// BranchDrawer now mounts LogsTab (Task 13) unconditionally on its Logs tab, which reaches for a
// real EventSource when no `makeSource` is injected — jsdom has none (mirrors app.test.tsx's own
// stub for useEvents' startEvents, same root cause). This file's tests exercise BranchDrawer's own
// concerns (rename, connstring, danger zone, etc.), not the log stream's content, so an inert stub
// (no real connection, no automatic events) is all that's needed to keep the drawer's mount hermetic.
// logs-tab.test.tsx covers the real SSE behavior via its own injected FakeES.
//
// `static last` + `closed` (Fix 1): mirrors logs-tab.test.tsx's own FakeES shape so the stale-Logs
// re-target test below can reach the live instance directly (LogsTab always calls `new
// EventSource(url)` itself here — there's no `makeSource` injection point through BranchDrawer —
// and can assert it was actually closed on remount, not just left dangling).
class InertEventSource {
  static last: InertEventSource | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((m: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { InertEventSource.last = this; }
  close(): void { this.closed = true; }
}
vi.stubGlobal("EventSource", InertEventSource);

const branch: BranchDto = {
  id: "b1", projectId: "p1", parentBranchId: "b-main", name: "agent-fix", slug: "agent-fix-s",
  timelineId: "t".repeat(32), endpointStatus: "running", endpointError: null, port: 54303,
  connectionString: "postgresql://postgres:S3CRET@localhost:54303/postgres",
  lastRecordLsn: "0/169AD58", logicalSizeBytes: 24117248, createdBy: "mcp",
  context: { agent: "claude", git_branch: "fix-1", purpose: "repro the bug" },
  ancestorLsn: "0/1690000", createdAt: "2026-07-03T10:00:00Z", updatedAt: "2026-07-03T10:00:00Z",
  runningPgVersion: null,
};

// Root fixture (repo convention, see BranchActionsMenu.test.tsx's rootBranch): a root branch has
// no parent and no connection secret to leak here, so it's kept minimal — only the fields the
// root-guard tests touch matter.
const rootBranch: BranchDto = {
  ...branch, id: "b-root", parentBranchId: null, name: "main", connectionString: null,
};

// A second, distinct non-root branch (sibling of `branch`) for the stale-tab-state re-target test
// below (Fix 1) — needs its own id so LogsTab/RestoreTab's per-branch component-local state has
// something to (incorrectly, pre-fix) leak across.
const branch2: BranchDto = { ...branch, id: "b2", name: "other-branch" };

// Default status fixture (Task 14): InfoTab now calls useStatus() itself for the restart-to-adopt
// chip. An empty pgBuilds keeps the existing (pre-Task-14) drawer tests inert — InfoTab.tsx only
// renders the Badge when `status.pgBuilds[major]?.activeVersion` differs from `runningPgVersion`,
// and the shared `branch` fixture's `runningPgVersion` is null, so this default never fires it.
const status: StatusDto = {
  version: "0.1.0", healthy: true,
  engine: { pageserver: { state: "running", pid: 1 }, safekeeper: { state: "running", pid: 2 } },
  portRange: { min: 54300, max: 54339 }, storage: "none", pgBuilds: {},
};

beforeEach(() => {
  vi.mocked(api.branches.get).mockImplementation(async (id: string) => {
    if (id === rootBranch.id) return rootBranch;
    if (id === branch2.id) return branch2;
    return branch;
  });
  vi.mocked(api.status).mockResolvedValue(status);
});

describe("maskConnstring", () => {
  // Table-driven: a masking function must fail CLOSED, so every case below asserts the password
  // substring is ABSENT from the output — not just that *some* masking happened — for any scheme,
  // not only the `postgresql://` shape the original (now-fixed) anchored regex assumed.
  const cases: Array<{ name: string; input: string; password: string }> = [
    { name: "postgresql:// (standard scheme)", input: "postgresql://postgres:S3CRET@localhost:54303/postgres", password: "S3CRET" },
    { name: "postgres:// (short scheme — RED pre-fix: the old regex was anchored to `postgresql://` and left this unmasked)", input: "postgres://postgres:S3CRET@host:5432/db", password: "S3CRET" },
    { name: "password containing a colon", input: "postgresql://u:pa:ss@h:1/d", password: "pa:ss" },
  ];

  it.each(cases)("masks the password for $name", ({ input, password }) => {
    const masked = maskConnstring(input);
    expect(masked).not.toContain(password);
  });

  it("leaves a no-password connstring unchanged (no userinfo secret to mask)", () => {
    expect(maskConnstring("postgresql://u@h:1/d")).toBe("postgresql://u@h:1/d");
  });
});

describe("BranchDrawer", () => {
  it("shows masked connstring; copy writes the real one", async () => {
    const write = vi.fn();
    Object.assign(navigator, { clipboard: { writeText: write } });
    renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    expect(await screen.findByText(/postgresql:\/\/postgres:•••@localhost:54303/)).toBeInTheDocument();
    expect(screen.queryByText(/S3CRET/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(write).toHaveBeenCalledWith(branch.connectionString);
  });

  it("renames inline through the pencil", async () => {
    vi.mocked(api.branches.rename).mockResolvedValue({ ...branch, name: "better-name" });
    renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /rename/i }));
    const input = screen.getByDisplayValue("agent-fix");
    await userEvent.clear(input);
    await userEvent.type(input, "better-name{enter}");
    await waitFor(() => expect(api.branches.rename).toHaveBeenCalledWith("b1", "better-name"));
  });

  it("shows fork context and Info metadata", async () => {
    renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    expect(await screen.findByText(/repro the bug/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /info/i }));
    expect(screen.getByText("0/169AD58")).toBeInTheDocument();
    expect(screen.getByText(/23\.0 MB/)).toBeInTheDocument(); // 24117248 bytes
  });

  describe("restart-to-adopt chip (Info tab)", () => {
    it("shows the badge when the running compute's major has a newer active build", async () => {
      vi.mocked(api.branches.get).mockResolvedValue({ ...branch, runningPgVersion: "16.9" });
      vi.mocked(api.status).mockResolvedValue({
        ...status,
        pgBuilds: { "16": { activeVersion: "16.10", source: "downloaded", degradedDowngrade: false, updateAvailable: null } },
      });
      renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
      await userEvent.click(await screen.findByRole("tab", { name: /info/i }));
      expect(await screen.findByText("restart to adopt 16.10")).toBeInTheDocument();
    });

    it("shows no badge when the running version already matches the active build", async () => {
      vi.mocked(api.branches.get).mockResolvedValue({ ...branch, runningPgVersion: "16.10" });
      vi.mocked(api.status).mockResolvedValue({
        ...status,
        pgBuilds: { "16": { activeVersion: "16.10", source: "downloaded", degradedDowngrade: false, updateAvailable: null } },
      });
      renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
      await userEvent.click(await screen.findByRole("tab", { name: /info/i }));
      // Wait on a real element from this Info render before asserting a negative, so the query
      // doesn't just pass because the tab hasn't painted yet.
      expect(await screen.findByText("0/169AD58")).toBeInTheDocument();
      expect(screen.queryByText(/restart to adopt/i)).not.toBeInTheDocument();
    });

    it("shows no badge when the endpoint is stopped (runningPgVersion null)", async () => {
      vi.mocked(api.branches.get).mockResolvedValue({ ...branch, runningPgVersion: null });
      vi.mocked(api.status).mockResolvedValue({
        ...status,
        pgBuilds: { "16": { activeVersion: "16.10", source: "downloaded", degradedDowngrade: false, updateAvailable: null } },
      });
      renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
      await userEvent.click(await screen.findByRole("tab", { name: /info/i }));
      expect(await screen.findByText("0/169AD58")).toBeInTheDocument();
      expect(screen.queryByText(/restart to adopt/i)).not.toBeInTheDocument();
    });
  });

  it("root-rename edit state does not survive a switch to the root branch", async () => {
    // Mocks accumulate across `it()`s in this file (vite.config.ts sets no clearMocks/restoreMocks,
    // matching BranchActionsMenu.test.tsx's documented convention) — an earlier test in this file
    // already legitimately called api.branches.rename once, so the assertion below must be "no NEW
    // call happened", not "never called at all".
    const callsBefore = vi.mocked(api.branches.rename).mock.calls.length;

    const { rerender } = renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    // Start editing the CHILD branch: click the pencil, type a draft (do not submit).
    await userEvent.click(await screen.findByRole("button", { name: /rename/i }));
    const input = screen.getByDisplayValue("agent-fix");
    await userEvent.clear(input);
    await userEvent.type(input, "in-progress-draft");

    // Re-render with a ROOT-branch id — this is the same drawer instance observing a branchId
    // change, mirroring a user switching tree selection while an edit was mid-flight.
    rerender(<BranchDrawer branchId="b-root" onClose={() => {}} />);

    // The root's name must render as plain text, and no TextInput must be present: if `editing`
    // state had survived, Enter here would call `rename.mutate` with the root id — a forbidden
    // path the daemon 400s.
    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("in-progress-draft")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /rename/i })).toBeDisabled();
    expect(vi.mocked(api.branches.rename).mock.calls).toHaveLength(callsBefore);
  });

  // Fix 1 (broker: same recurring stale-state class as the root-rename test above, Tasks 10/12
  // precedent). LogsTab and RestoreTab are unkeyed children of the Tabs.Panel — a branchId change
  // on the SAME BranchDrawer instance (re-targeting the drawer to a different branch without
  // closing/reopening it) updates their `branchId`/`branch` props but does NOT unmount them, so
  // their internal `useState` (LogsTab's `lines`; RestoreTab's `to`/`selectedPreset`/`mode`/`name`)
  // survives untouched. A leftover in-place restore selection on the OLD branch would leave the
  // Restore button enabled against the NEW branch with no user having chosen a restore point for
  // it — a rewind that could fire against the wrong target. Keying both tabs by `b.id` forces
  // React to remount them fresh on every branchId change, which this test proves from the outside.
  it("Restore selection does not survive a switch to a different branch (stale-state class, cf. root-rename above)", async () => {
    // Pre-seed b2 into the SAME query client the drawer will use (staleTime: Infinity, per
    // makeQueryClient — so this cached entry is treated as fresh, no background refetch races it).
    // Without this, `useBranch`'s query key changes (["branch","b1"] -> ["branch","b2"]) on the
    // rerender below, `data` transiently goes undefined while the new key's fetch resolves, and
    // BranchDrawer's `if (!b) return <Skeleton/>` branch actually unmounts the whole Tabs tree on
    // its own — which would ALSO wipe RestoreTab's state, accidentally masking the exact bug this
    // test exists to catch. Seeding the cache keeps `b` continuously truthy across the branchId
    // change, so any state surviving the rerender can only be surviving because it's unkeyed, not
    // because of an incidental loading-state unmount.
    const client = makeQueryClient();
    client.setQueryData(keys.branch(branch2.id), branch2);

    const { rerender } = renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />, { client });
    await userEvent.click(await screen.findByRole("tab", { name: /restore/i }));

    // Pick a preset on b1: this enables the Restore button (a selected timestamp is the only gate
    // for `in_place` mode, the tab's default).
    await userEvent.click(await screen.findByRole("checkbox", { name: /30 m/i }));
    expect(screen.getByRole("button", { name: /restore/i })).toBeEnabled();

    // Re-target the SAME drawer instance to a different, unrelated branch (b2) — mirrors a user
    // clicking a different node in the branch tree while the drawer stays open.
    rerender(<BranchDrawer branchId="b2" onClose={() => {}} />);

    // Land back on the Restore tab for b2 (Tabs itself does not persist the active tab across a
    // remount of its owning component in this app's usage, so re-select it explicitly) and assert
    // NO restore point carried over: the button must be freshly disabled, not still enabled against
    // a selection the user never made for b2.
    await userEvent.click(await screen.findByRole("tab", { name: /restore/i }));
    expect(await screen.findByRole("button", { name: /restore/i })).toBeDisabled();
    expect(screen.queryByRole("checkbox", { name: /30 m/i, checked: true })).not.toBeInTheDocument();
  });

  // Companion to the Restore test above: same re-target apparatus (cache-primed b2, no incidental
  // Skeleton unmount), proving LogsTab's `lines` buffer specifically does not survive a BranchDrawer
  // re-target, AND that the stale b1 EventSource actually gets closed (not just abandoned) —
  // exercised at the BranchDrawer level itself (LogsTab has no `makeSource` injection point through
  // BranchDrawer, so this drives the file's InertEventSource directly, unlike logs-tab.test.tsx's
  // own FakeES-injected coverage of the same contract in isolation).
  it("Logs buffer and connection do not survive a switch to a different branch (stale-state class)", async () => {
    const client = makeQueryClient();
    client.setQueryData(keys.branch(branch2.id), branch2);

    const { rerender } = renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />, { client });
    await userEvent.click(await screen.findByRole("tab", { name: /logs/i }));
    const b1Source = InertEventSource.last!;
    expect(b1Source.url).toBe("/api/branches/b1/logs");

    act(() => { b1Source.onmessage?.({ data: JSON.stringify("b1 log line") } as MessageEvent); });
    expect(await screen.findByText("b1 log line")).toBeInTheDocument();

    // Re-target the SAME drawer instance to b2 — mirrors a user clicking a different branch-tree
    // node while the drawer stays open on the Logs tab.
    rerender(<BranchDrawer branchId="b2" onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("tab", { name: /logs/i }));

    // The stale b1 stream must be closed (not silently left open, e.g. if a fix connected a new
    // stream without tearing down the old one), and b2 gets its OWN fresh connection + empty buffer.
    expect(b1Source.closed).toBe(true);
    const b2Source = InertEventSource.last!;
    expect(b2Source).not.toBe(b1Source);
    expect(b2Source.url).toBe("/api/branches/b2/logs");
    expect(screen.queryByText("b1 log line")).not.toBeInTheDocument();
    expect(await screen.findByText(/no output yet/i)).toBeInTheDocument();
  });

  describe("danger zone: delete", () => {
    it("confirmed: calls api.branches.delete with the id and fires onClose", async () => {
      const onClose = vi.fn();
      vi.spyOn(window, "confirm").mockReturnValue(true);
      vi.mocked(api.branches.delete).mockResolvedValue(undefined);
      renderApp(<BranchDrawer branchId="b1" onClose={onClose} />);
      await userEvent.click(await screen.findByRole("button", { name: /delete branch/i }));
      // TanStack Query v5's mutationFn(variables, context) 2-arg shape (see BranchActionsMenu.test.tsx,
      // dashboard.test.tsx) — assert on the call's first argument, not the full call.
      await waitFor(() => expect(vi.mocked(api.branches.delete).mock.calls.at(-1)?.[0]).toEqual("b1"));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("dismissed: calls neither api.branches.delete nor onClose", async () => {
      const onClose = vi.fn();
      vi.spyOn(window, "confirm").mockReturnValue(false);
      renderApp(<BranchDrawer branchId="b1" onClose={onClose} />);
      const callsBefore = vi.mocked(api.branches.delete).mock.calls.length;
      await userEvent.click(await screen.findByRole("button", { name: /delete branch/i }));
      expect(vi.mocked(api.branches.delete).mock.calls).toHaveLength(callsBefore);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("danger zone: reset from parent", () => {
    it("dismissed: does not call api.branches.reset", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
      const callsBefore = vi.mocked(api.branches.reset).mock.calls.length;
      await userEvent.click(await screen.findByRole("button", { name: /reset from parent/i }));
      expect(vi.mocked(api.branches.reset).mock.calls).toHaveLength(callsBefore);
    });

    it("confirmed (child branch): calls api.branches.reset with the id", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      vi.mocked(api.branches.reset).mockResolvedValue(branch);
      renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
      await userEvent.click(await screen.findByRole("button", { name: /reset from parent/i }));
      await waitFor(() => expect(vi.mocked(api.branches.reset).mock.calls.at(-1)?.[0]).toEqual("b1"));
    });

    it("root branch: Reset control is disabled and never confirms or mutates", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      renderApp(<BranchDrawer branchId="b-root" onClose={() => {}} />);
      const resetButton = await screen.findByRole("button", { name: /reset from parent/i });
      expect(resetButton).toBeDisabled();
      const callsBefore = vi.mocked(api.branches.reset).mock.calls.length;
      const confirmCallsBefore = confirmSpy.mock.calls.length;
      await userEvent.click(resetButton);
      expect(vi.mocked(api.branches.reset).mock.calls).toHaveLength(callsBefore);
      expect(confirmSpy.mock.calls).toHaveLength(confirmCallsBefore);
    });
  });
});

describe("formatBytes", () => {
  // Table-driven: pins the KB/MB/GB thresholds and null handling directly, independent of the
  // rendered drawer (which only ever exercises one value via the branch fixture above).
  const cases: Array<{ name: string; input: number | null; expected: string }> = [
    { name: "null", input: null, expected: "—" },
    { name: "sub-KB value", input: 512, expected: "0.5 KB" },
    { name: "exactly 1 KB region", input: 1024, expected: "1.0 KB" },
    { name: "just below 1 MB", input: 1024 * 1024 - 1, expected: "1024.0 KB" },
    { name: "at 1 MB", input: 1024 * 1024, expected: "1.0 MB" },
    { name: "just below 1 GB", input: 1024 * 1024 * 1024 - 1, expected: "1024.0 MB" },
    { name: "at 1 GB", input: 1024 * 1024 * 1024, expected: "1.00 GB" },
  ];

  it.each(cases)("formats $name as $expected", ({ input, expected }) => {
    expect(formatBytes(input)).toBe(expected);
  });
});
