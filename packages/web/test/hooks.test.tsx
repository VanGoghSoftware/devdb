import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import { makeQueryClient } from "./render.js";
import { useEvents } from "../src/api/hooks.js";

vi.mock("../src/api/events.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/api/events.js")>();
  return { ...mod, startEvents: vi.fn(() => () => {}) };
});
import { startEvents } from "../src/api/events.js";

describe("useEvents", () => {
  // `startEvents` is a module-level mock shared across every `it()` in this file — reset its
  // call history (but keep the `() => () => {}` factory as the baseline) between tests so
  // call-count assertions below start from a clean slate instead of accumulating across tests.
  beforeEach(() => {
    (startEvents as ReturnType<typeof vi.fn>).mockClear();
    (startEvents as ReturnType<typeof vi.fn>).mockImplementation(() => () => {});
  });

  it("starts the stream once, blanket-invalidates on open, and invalidates mapped keys per event", async () => {
    const client = makeQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}><MantineProvider>{children}</MantineProvider></QueryClientProvider>
    );
    renderHook(() => useEvents(), { wrapper });
    expect(startEvents).toHaveBeenCalledTimes(1);
    const opts = (startEvents as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    opts.onOpen();
    expect(invalidate).toHaveBeenCalledWith(); // blanket
    opts.onEvent({ type: "branch.created", projectId: "p1", branchId: "b1", at: "t" });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["branches", "p1"] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["branch", "b1"] });
    });
  });

  it("mounts the stream exactly once across rerenders and cleans up exactly once on unmount", () => {
    const cleanup = vi.fn();
    (startEvents as ReturnType<typeof vi.fn>).mockReturnValue(cleanup);
    const client = makeQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}><MantineProvider>{children}</MantineProvider></QueryClientProvider>
    );
    const { rerender, unmount } = renderHook(() => useEvents(), { wrapper });

    expect(startEvents).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();

    // Rerender under the SAME QueryClient wrapper — the effect's dependency (qc) is unchanged,
    // so it must not re-subscribe (no new startEvents call) or tear down the existing stream.
    rerender();
    expect(startEvents).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();

    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
