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
  });
});
