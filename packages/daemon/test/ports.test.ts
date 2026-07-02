import { describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { allocatePort, PortExhaustedError } from "../src/compute/ports.js";

describe("allocatePort", () => {
  it("prefers the sticky port when free", async () => {
    expect(await allocatePort({ min: 56000, max: 56010 }, 56005)).toBe(56005);
  });
  it("falls back into the range when sticky is taken", async () => {
    const blocker = net.createServer().listen(56005, "127.0.0.1");
    await once(blocker, "listening");
    try {
      const p = await allocatePort({ min: 56000, max: 56010 }, 56005);
      expect(p).toBeGreaterThanOrEqual(56000);
      expect(p).toBeLessThanOrEqual(56010);
      expect(p).not.toBe(56005);
    } finally { blocker.close(); }
  });
  it("throws PortExhaustedError when range is fully occupied", async () => {
    const blockers = await Promise.all([56020, 56021].map(async (p) => {
      const s = net.createServer().listen(p, "127.0.0.1");
      await once(s, "listening");
      return s;
    }));
    try {
      await expect(allocatePort({ min: 56020, max: 56021 })).rejects.toBeInstanceOf(PortExhaustedError);
    } finally { blockers.forEach((s) => s.close()); }
  });
  it("skips excluded candidates, including the preferred port, and returns the remaining free one", async () => {
    const p = await allocatePort({ min: 56100, max: 56101 }, 56100, new Set([56100]));
    expect(p).toBe(56101);
  });
  it("throws PortExhaustedError when every candidate in range is excluded", async () => {
    await expect(
      allocatePort({ min: 56100, max: 56101 }, undefined, new Set([56100, 56101])),
    ).rejects.toBeInstanceOf(PortExhaustedError);
  });
});
