import { describe, expect, it } from "vitest";
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
});
