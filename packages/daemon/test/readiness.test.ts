import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseComputeCtlUpStatus, waitComputeReady } from "../src/compute/readiness.js";

const metrics = (s: "init" | "running" | "failed") => `# HELP compute_ctl_up ...
compute_ctl_up{status="init"} ${s === "init" ? 1 : 0}
compute_ctl_up{status="running"} ${s === "running" ? 1 : 0}
compute_ctl_up{status="failed"} ${s === "failed" ? 1 : 0}
`;

describe("parseComputeCtlUpStatus", () => {
  it("returns the status whose gauge value is 1", () => {
    expect(parseComputeCtlUpStatus(metrics("init"))).toBe("init");
    expect(parseComputeCtlUpStatus(metrics("running"))).toBe("running");
    expect(parseComputeCtlUpStatus("nothing here")).toBeNull();
  });
});

describe("waitComputeReady", () => {
  it("resolves once status flips to running", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return { ok: true, text: async () => metrics(calls < 3 ? "init" : "running") } as Response;
    }) as typeof fetch;
    await waitComputeReady(40123, { intervalMs: 1, fetchImpl });
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("rejects on failed", async () => {
    const fetchImpl = (async () => ({ ok: true, text: async () => metrics("failed") }) as Response) as typeof fetch;
    await expect(waitComputeReady(40123, { intervalMs: 1, fetchImpl })).rejects.toThrow(/failed/);
  });

  it("rejects on timeout", async () => {
    const fetchImpl = (async () => ({ ok: true, text: async () => metrics("init") }) as Response) as typeof fetch;
    await expect(waitComputeReady(40123, { timeoutMs: 5, intervalMs: 1, fetchImpl })).rejects.toThrow(/timed out/);
  });

  // Fix 2 (review, regression guard): the pre-fix loop only checked `Date.now() > deadline`
  // BETWEEN attempts — it awaited `fetchImpl(...)` with no per-attempt bound at all, so a
  // `fetchImpl` that never resolves or rejects on its own hung the whole function forever
  // (and, in start(), the branch's queue lane + reserved ports + compute_ctl process along with
  // it). This fake fetch mimics a hung TCP connect/headers/body: it ignores its `init.signal`
  // entirely UNTIL that signal aborts, at which point (like real `fetch`) it rejects with an
  // abort-shaped error — proving the fix's per-attempt AbortController is what unsticks it, not
  // any cooperation from the fetch implementation itself.
  it("rejects by timeoutMs even when fetchImpl's own promise never settles (hung request)", async () => {
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const reason = init.signal!.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        });
        // No timer, no resolve/reject of its own: this promise settles ONLY via the abort
        // listener above — exactly the "hung fetch" this fix must not be defeated by.
      })) as typeof fetch;

    const start = Date.now();
    await expect(waitComputeReady(40123, { timeoutMs: 30, intervalMs: 1, fetchImpl })).rejects.toThrow(/timed out/);
    // Real wall-clock bound (no fake timers here — see the external-abort test below for why):
    // generously above 30ms to absorb CI jitter, but tight enough that a regression back to
    // "only checked between attempts" (which would hang indefinitely) fails this test rather
    // than timing out the whole suite.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  describe("external signal cancellation", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // Fix 2 (review, regression guard): `opts.signal` must be honored PROMPTLY — well before
    // `timeoutMs` — not just folded into the same deadline. Fake timers let this assert the
    // abort is observed immediately (a single microtask flush) rather than only after real time
    // has actually elapsed, distinguishing "abort checked promptly" from "abort eventually wins
    // because the deadline was reached anyway."
    it("rejects promptly on an external signal abort, well before timeoutMs elapses", async () => {
      const fetchImpl = (async () => ({ ok: true, text: async () => metrics("init") }) as Response) as typeof fetch;
      const ctl = new AbortController();

      const promise = waitComputeReady(40123, { timeoutMs: 50_000, intervalMs: 100, fetchImpl, signal: ctl.signal });
      const assertion = expect(promise).rejects.toThrow(/aborted|cancel/i);

      // Let the first poll attempt (immediate, no sleep yet) run, then abort externally.
      await vi.advanceTimersByTimeAsync(0);
      ctl.abort(new Error("caller cancelled"));
      await vi.advanceTimersByTimeAsync(0);

      await assertion;
    });

    // Same guard, but the abort arrives while the loop is asleep in its inter-poll interval —
    // the sleep itself must be abortable rather than always waiting out the full `intervalMs`.
    it("rejects promptly on an external signal abort that arrives during the inter-poll sleep", async () => {
      const fetchImpl = (async () => ({ ok: true, text: async () => metrics("init") }) as Response) as typeof fetch;
      const ctl = new AbortController();

      const promise = waitComputeReady(40123, { timeoutMs: 50_000, intervalMs: 10_000, fetchImpl, signal: ctl.signal });
      const assertion = expect(promise).rejects.toThrow(/aborted|cancel/i);

      // Flush the first (immediate) attempt so the loop reaches its sleep, well short of the
      // 10s interval, then abort — proving the sleep itself doesn't block the cancellation.
      await vi.advanceTimersByTimeAsync(0);
      ctl.abort(new Error("caller cancelled"));
      await vi.advanceTimersByTimeAsync(0);

      await assertion;
    });
  });
});
