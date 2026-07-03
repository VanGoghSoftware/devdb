import { describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { allocatePort, PortExhaustedError } from "../src/compute/ports.js";

// Probe that parks on the macrotask queue before granting the port, forcing concurrent
// allocatePort calls to genuinely interleave across the await — the exact shape of two
// parallel branch starts (distinct queue lanes) racing tryBind against the same free port.
async function yieldingProbe(_port: number): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 0));
  return true;
}

describe("allocatePort", () => {
  it("prefers the sticky port when free", async () => {
    expect(await allocatePort({ min: 56000, max: 56010 }, 56005)).toBe(56005);
  });
  it("falls back into the range when sticky is taken, unclaiming the failed sticky candidate", async () => {
    const blocker = net.createServer().listen(56005, "127.0.0.1");
    await once(blocker, "listening");
    const reserved = new Set<number>();
    try {
      const p = await allocatePort({ min: 56000, max: 56010 }, 56005, reserved);
      expect(p).toBeGreaterThanOrEqual(56000);
      expect(p).toBeLessThanOrEqual(56010);
      expect(p).not.toBe(56005);
      // The sticky candidate was claimed for its probe, then released when the bind failed;
      // only the port actually handed out stays claimed.
      expect(reserved).toEqual(new Set([p]));
    } finally { blocker.close(); }
  });
  it("throws PortExhaustedError when range is fully occupied, leaving nothing claimed", async () => {
    const blockers = await Promise.all([56020, 56021].map(async (p) => {
      const s = net.createServer().listen(p, "127.0.0.1");
      await once(s, "listening");
      return s;
    }));
    const reserved = new Set<number>();
    try {
      await expect(
        allocatePort({ min: 56020, max: 56021 }, undefined, reserved),
      ).rejects.toBeInstanceOf(PortExhaustedError);
      expect(reserved.size).toBe(0); // every claim made for a probe was released on its failure
    } finally { blockers.forEach((s) => s.close()); }
  });
  it("skips already-reserved candidates, including the preferred port, and claims the free one", async () => {
    const reserved = new Set([56100]);
    const p = await allocatePort({ min: 56100, max: 56101 }, 56100, reserved);
    expect(p).toBe(56101);
    expect(reserved).toEqual(new Set([56100, 56101])); // 56101 claimed by allocatePort itself
  });
  it("throws PortExhaustedError when every candidate in range is already reserved", async () => {
    const reserved = new Set([56100, 56101]);
    await expect(
      allocatePort({ min: 56100, max: 56101 }, undefined, reserved),
    ).rejects.toBeInstanceOf(PortExhaustedError);
    expect(reserved).toEqual(new Set([56100, 56101])); // untouched — nothing new claimed
  });

  // Reserve-then-probe TOCTOU coverage: a candidate must be CLAIMED into the shared reserved
  // set synchronously — before the probe's await — or two calls interleaving across that await
  // both see the port unreserved, both pass the probe (tryBind's throwaway server grants no
  // exclusivity), and both are handed the same port. The injected yieldingProbe forces every
  // call to suspend across a macrotask, driving the interleave deterministically.
  it("never hands the same preferred port to two concurrent calls sharing a reserved set", async () => {
    const reserved = new Set<number>();
    const [a, b] = await Promise.all([
      allocatePort({ min: 56200, max: 56201 }, 56200, reserved, yieldingProbe),
      allocatePort({ min: 56200, max: 56201 }, 56200, reserved, yieldingProbe),
    ]);
    // Pre-fix both calls returned 56200: each checked the (still-empty) set, then awaited.
    expect(a).not.toBe(b);
    expect(new Set([a, b])).toEqual(new Set([56200, 56201]));
    expect(reserved).toEqual(new Set([56200, 56201]));
  });
  it("N concurrent calls over an N-port range get N distinct ports and the (N+1)th exhausts", async () => {
    const range = { min: 56300, max: 56303 }; // exactly 4 ports
    const reserved = new Set<number>();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => allocatePort(range, undefined, reserved, yieldingProbe)),
    );
    const fulfilled: number[] = [];
    const rejections: unknown[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") fulfilled.push(r.value);
      else rejections.push(r.reason);
    }
    // Pre-fix no call claims before its await, so all 5 fulfil out of a 4-port domain — a
    // pigeonhole-guaranteed duplicate handed to two callers.
    expect(fulfilled).toHaveLength(4);
    expect(new Set(fulfilled).size).toBe(4); // no duplicate port
    for (const p of fulfilled) {
      expect(p).toBeGreaterThanOrEqual(range.min);
      expect(p).toBeLessThanOrEqual(range.max);
    }
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toBeInstanceOf(PortExhaustedError);
    expect(reserved).toEqual(new Set(fulfilled)); // exactly the handed-out ports stay claimed
  });
  it("releases the claim and propagates when the probe rejects — no leak on a throwing probe", async () => {
    const reserved = new Set<number>();
    const boom = new Error("probe exploded");
    await expect(
      allocatePort({ min: 56400, max: 56401 }, 56400, reserved, () => Promise.reject(boom)),
    ).rejects.toBe(boom);
    // Pre-fix the candidate stayed claimed: `delete` ran only after a `false` return, never on a
    // throw, so a rejecting probe leaked its claim into the shared set. The finally releases it on
    // either path — the throw propagates unchanged, but nothing is left reserved.
    expect(reserved.size).toBe(0);
  });
});
