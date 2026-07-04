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
});
