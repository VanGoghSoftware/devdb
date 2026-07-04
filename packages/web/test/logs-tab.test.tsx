import { describe, expect, it } from "vitest";
import { screen, act } from "@testing-library/react";
import { renderApp } from "./render.js";
import { LogsTab } from "../src/drawer/LogsTab.js";

class FakeES {
  static last: FakeES | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  close() { this.closed = true; }
}

describe("LogsTab", () => {
  it("connects to the branch log stream and renders JSON-decoded lines in order", () => {
    renderApp(<LogsTab branchId="b1" makeSource={(u) => new FakeES(u) as unknown as EventSource} />);
    expect(FakeES.last!.url).toBe("/api/branches/b1/logs");
    act(() => {
      FakeES.last!.onmessage?.({ data: JSON.stringify("LOG:  statement: BEGIN") });
      FakeES.last!.onmessage?.({ data: JSON.stringify("LOG:  duration: 2.31 ms") });
    });
    const lines = screen.getAllByTestId("log-line").map((el) => el.textContent);
    expect(lines).toEqual(["LOG:  statement: BEGIN", "LOG:  duration: 2.31 ms"]);
  });
  it("closes the stream on unmount", () => {
    const { unmount } = renderApp(<LogsTab branchId="b1" makeSource={(u) => new FakeES(u) as unknown as EventSource} />);
    unmount();
    expect(FakeES.last!.closed).toBe(true);
  });

  // Fix 1 (broker: recurring stale-state class, cf. Tasks 10/12's editing/draft precedent in
  // drawer.test.tsx). LogsTab's `lines` buffer + EventSource are component-local state keyed only
  // by React's own instance identity, not by `branchId` — a parent that changes the `branchId` prop
  // WITHOUT unmounting (e.g. BranchDrawer re-targeting to a different branch in its tree) would
  // otherwise keep rendering b1's already-buffered lines while the connection silently migrates to
  // b2's stream, and never actually close the stale b1 EventSource. BranchDrawer's real fix is
  // `key={b.id}` on <LogsTab>, which forces React to unmount/remount rather than prop-update — this
  // test proves that BEHAVIOR (old lines gone, old stream closed, fresh stream opened) by simulating
  // the remount here directly (unmount + fresh mount is what a `key` change does under the hood),
  // rather than depending on BranchDrawer's JSX, so this file stays the authority on LogsTab's own
  // contract independent of how any particular parent chooses to key it.
  it("a remount for a different branchId (as `key={branchId}` forces) drops old lines, closes the old stream, and opens a fresh one", () => {
    const { unmount } = renderApp(<LogsTab branchId="b1" makeSource={(u) => new FakeES(u) as unknown as EventSource} />);
    const firstSource = FakeES.last!;
    expect(firstSource.url).toBe("/api/branches/b1/logs");
    act(() => { firstSource.onmessage?.({ data: JSON.stringify("b1 line") }); });
    expect(screen.getAllByTestId("log-line").map((el) => el.textContent)).toEqual(["b1 line"]);

    // Simulate what `key={b.id}` does on a branchId change: unmount the old instance, mount a new
    // one. (A plain `rerender` with a new `branchId` prop, with no `key`, would NOT unmount — that
    // is exactly the bug this test guards against at the BranchDrawer level.)
    unmount();
    expect(firstSource.closed).toBe(true);

    renderApp(<LogsTab branchId="b2" makeSource={(u) => new FakeES(u) as unknown as EventSource} />);
    const secondSource = FakeES.last!;
    expect(secondSource).not.toBe(firstSource);
    expect(secondSource.url).toBe("/api/branches/b2/logs");
    expect(screen.queryByText("b1 line")).not.toBeInTheDocument();

    act(() => { secondSource.onmessage?.({ data: JSON.stringify("b2 line") }); });
    expect(screen.getAllByTestId("log-line").map((el) => el.textContent)).toEqual(["b2 line"]);
  });

  // Fix 2 (P4 / key risk): a malformed frame must be dropped silently, not crash the SSE handler
  // (which would tear down the rest of the tab) and not render as a phantom line. Two distinct
  // malformed shapes: (a) `data` that isn't valid JSON at all — `JSON.parse` throws, caught by the
  // component's own try/catch; (b) `data` that IS valid JSON but decodes to a non-string (e.g. a
  // bare number) — parses cleanly, so only the `typeof line === "string"` guard (not the catch)
  // stops it from being appended.
  it("ignores a non-JSON frame and a JSON non-string frame without throwing or adding a line", () => {
    renderApp(<LogsTab branchId="b1" makeSource={(u) => new FakeES(u) as unknown as EventSource} />);
    expect(() => {
      act(() => {
        FakeES.last!.onmessage?.({ data: "not json" }); // raw string, not a JSON-encoded string — JSON.parse throws
        FakeES.last!.onmessage?.({ data: "42" }); // valid JSON, but decodes to a number, not a string
      });
    }).not.toThrow();
    expect(screen.queryAllByTestId("log-line")).toHaveLength(0);
    expect(screen.getByText(/no output yet/i)).toBeInTheDocument();
  });

  // Fix 2 (P4 / key risk): the client-side MAX_LINES=500 display cap must actually cap — sending
  // more than 500 frames keeps exactly the last 500, in order, not an unbounded or off-by-one buffer.
  it("keeps exactly the last 500 lines, in order, when more than 500 frames arrive", () => {
    renderApp(<LogsTab branchId="b1" makeSource={(u) => new FakeES(u) as unknown as EventSource} />);
    act(() => {
      for (let i = 0; i < 620; i++) {
        FakeES.last!.onmessage?.({ data: JSON.stringify(`line-${i}`) });
      }
    });
    const lines = screen.getAllByTestId("log-line").map((el) => el.textContent);
    expect(lines).toHaveLength(500);
    // 620 frames sent (indices 0..619), capped at 500: the retained tail is line-120..line-619.
    expect(lines[0]).toBe("line-120");
    expect(lines[lines.length - 1]).toBe("line-619");
  });
});
