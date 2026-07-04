import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("boot", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("reports all engine components running", async () => {
    const res = await fetch(`${dev.base}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.healthy).toBe(true);
    for (const name of ["storcon_db", "storage_broker", "storage_controller", "safekeeper", "pageserver"]) {
      expect(body.engine[name].state, name).toBe("running");
    }
    for (const name of ["storage_broker", "storage_controller", "safekeeper", "pageserver"]) {
      expect(body.engine[name].pid, name).not.toBeNull();
    }
  });

  // broker P4 (parity): the health check above passes even if the tracer sink were absent/misbound,
  // letting OTLP + storage_controller notify-attach spam connection-refused again. Assert the sink
  // is actually serving 4318 in-container for both the OTLP and control-plane paths it absorbs
  // (oracle: neond src/daemon/tracer/mod.rs — any path -> 200). curl ships in the runtime image.
  it("serves the tracer/control-plane sink on 127.0.0.1:4318 inside the container", async () => {
    for (const path of ["/v1/traces", "/notify-attach"]) {
      const { output, exitCode } = await dev.container.exec([
        "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", `http://127.0.0.1:4318${path}`,
      ]);
      expect(exitCode, path).toBe(0);
      expect(output.trim(), path).toBe("200");
    }
  });
});
