import { afterEach, describe, expect, it } from "vitest";
import { Tracer } from "../src/engine/tracer.js";

// The tracer is a catch-all HTTP sink (oracle: neond src/daemon/tracer/mod.rs) that absorbs the
// engine binaries' OTLP trace exports AND the storage_controller's control-plane compute-notify
// upcalls — both target 127.0.0.1:4318, which nothing else serves. Every method + path → 200 "{}".
// Tests bind an OS-assigned ephemeral port (Tracer(0)) so they never touch the real 4318 or each other.
describe("Tracer — OTLP + control-plane sink", () => {
  let tracer: Tracer | null = null;
  afterEach(async () => {
    await tracer?.stop();
    tracer = null;
  });

  async function startEphemeral(): Promise<string> {
    tracer = new Tracer(0);
    await tracer.start();
    return `http://127.0.0.1:${tracer.boundPort}`;
  }

  it("answers 200 {} to the OTLP /v1/traces export", async () => {
    const base = await startEphemeral();
    const res = await fetch(`${base}/v1/traces`, { method: "POST", body: "trace-bytes" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("{}");
  });

  it("answers 200 {} to the control-plane /notify-attach upcall", async () => {
    const base = await startEphemeral();
    const res = await fetch(`${base}/notify-attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "abc" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("{}");
  });

  it("is a catch-all: arbitrary method + path still 200", async () => {
    const base = await startEphemeral();
    for (const [method, path] of [["GET", "/"], ["PUT", "/deep/nested/thing"], ["DELETE", "/upcall/v1/x"]] as const) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status).toBe(200);
    }
  });

  it("boundPort reflects the OS-assigned port when constructed with 0", async () => {
    await startEphemeral();
    expect(tracer!.boundPort).toBeGreaterThan(0);
  });

  it("stop() closes the listener so a later request is refused", async () => {
    const base = await startEphemeral();
    await tracer!.stop();
    tracer = null;
    await expect(fetch(base)).rejects.toThrow();
  });

  it("stop() is idempotent and safe before start()", async () => {
    const t = new Tracer(0);
    await expect(t.stop()).resolves.toBeUndefined();
    await t.start();
    await expect(t.stop()).resolves.toBeUndefined();
    await expect(t.stop()).resolves.toBeUndefined();
  });
});
