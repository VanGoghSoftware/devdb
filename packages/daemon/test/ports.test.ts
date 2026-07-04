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

// Deterministic probes for the pure allocation-LOGIC tests below: they exercise allocatePort's
// preferred / fallback / exhaustion / reserved branching without binding any real socket. Modeling
// port occupancy explicitly keeps those tests hermetic — they previously bound fixed 56xxx loopback
// ports, which a review-broker scan flagged (P4) as collision-prone with unrelated local/CI
// processes. The real tryBind path is covered on its own, against an OS-assigned ephemeral port, in
// the final test. The fixed port numbers that remain below are now just logical labels — nothing binds.
const grantAll = (_port: number): Promise<boolean> => Promise.resolve(true);
const denyAll = (_port: number): Promise<boolean> => Promise.resolve(false);

describe("allocatePort", () => {
  it("prefers the sticky port when free", async () => {
    // grantAll = the sticky port probes as free, so it must be returned without falling into the range.
    expect(await allocatePort({ min: 56000, max: 56010 }, 56005, undefined, grantAll)).toBe(56005);
  });
  it("falls back into the range when sticky is taken, unclaiming the failed sticky candidate", async () => {
    const taken = 56005; // the probe rejects only this port (a taken sticky); every other is free.
    const probed: number[] = [];
    const probe = (port: number): Promise<boolean> => { probed.push(port); return Promise.resolve(port !== taken); };
    const reserved = new Set<number>();
    const p = await allocatePort({ min: 56000, max: 56010 }, taken, reserved, probe);
    expect(probed[0]).toBe(taken); // the sticky candidate is attempted FIRST (preferred), then rejected...
    expect(p).not.toBe(taken); // ...so a different, free range port is handed out instead
    expect(p).toBeGreaterThanOrEqual(56000);
    expect(p).toBeLessThanOrEqual(56010);
    // The sticky candidate was claimed for its probe, then released when the probe rejected it;
    // only the port actually handed out stays claimed.
    expect(reserved).toEqual(new Set([p]));
  });
  it("throws PortExhaustedError when range is fully occupied, leaving nothing claimed", async () => {
    const reserved = new Set<number>();
    // denyAll = every candidate probes as in-use, so all 100 attempts fail and the range exhausts.
    await expect(
      allocatePort({ min: 56020, max: 56021 }, undefined, reserved, denyAll),
    ).rejects.toBeInstanceOf(PortExhaustedError);
    expect(reserved.size).toBe(0); // every claim made for a probe was released on its failure
  });
  it("skips already-reserved candidates, including the preferred port, and claims the free one", async () => {
    const reserved = new Set([56100]);
    // 56100 is skipped by the reserved-set check before any probe (including as the preferred port);
    // grantAll lets the only non-reserved candidate, 56101, probe as free.
    const p = await allocatePort({ min: 56100, max: 56101 }, 56100, reserved, grantAll);
    expect(p).toBe(56101);
    expect(reserved).toEqual(new Set([56100, 56101])); // 56101 claimed by allocatePort itself
  });
  it("throws PortExhaustedError when every candidate in range is already reserved", async () => {
    const reserved = new Set([56100, 56101]);
    let probeCalls = 0;
    const probe = (_port: number): Promise<boolean> => { probeCalls++; return Promise.resolve(true); };
    await expect(
      allocatePort({ min: 56100, max: 56101 }, undefined, reserved, probe),
    ).rejects.toBeInstanceOf(PortExhaustedError);
    expect(reserved).toEqual(new Set([56100, 56101])); // untouched — nothing new claimed
    expect(probeCalls).toBe(0); // every candidate skipped by the reserved check BEFORE any probe/bind
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

  // Real-probe coverage (the tryBind default, no probe arg) against an OS-assigned ephemeral port
  // rather than a fixed number. Every other test in this file injects a deterministic probe, so this
  // is the only one that exercises the real net.createServer().listen path end to end. Binding :0 lets
  // the OS hand us a port it knows is free *right now*, sidestepping the exact hazard that sank the
  // compute-manager tests — a hardcoded range (the default 54300-54339) sitting wholly under
  // docker-proxy while the compose container is up. tryBind must reject the port while it is held,
  // then grant it once released.
  it("with the default bind probe, rejects a held ephemeral port and grants it once released", async () => {
    const holder = net.createServer();
    holder.listen(0, "127.0.0.1");
    await once(holder, "listening");
    const addr = holder.address();
    if (addr === null || typeof addr === "string") throw new Error("expected an AddressInfo from listen(0)");
    const port = addr.port;

    // Held by `holder`: the real tryBind fails to bind it, so a single-port range exhausts.
    await expect(allocatePort({ min: port, max: port })).rejects.toBeInstanceOf(PortExhaustedError);

    // Released: the same real probe must now bind and hand back exactly that port.
    holder.close();
    await once(holder, "close");
    expect(await allocatePort({ min: port, max: port })).toBe(port);
  });
});
