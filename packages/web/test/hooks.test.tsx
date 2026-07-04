import { describe, expect, it, vi } from "vitest";
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
});
