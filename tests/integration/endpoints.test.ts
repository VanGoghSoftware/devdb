import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("endpoint port exhaustion", () => {
  let dev: Devdb;
  beforeAll(async () => {
    dev = await startDevdb({ DEVDB_PORT_RANGE: "54300-54301" });
  });
  afterAll(async () => { await dev?.stop(); });

  it("names running endpoints when the range is full", async () => {
    const mk = async (name: string) => {
      const r = await fetch(`${dev.base}/api/projects`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return (await r.json()).mainBranch.id as string;
    };
    const b1 = await mk("p1"); const b2 = await mk("p2"); const b3 = await mk("p3");
    for (const b of [b1, b2]) {
      const r = await fetch(`${dev.base}/api/branches/${b}/endpoint/start`, { method: "POST" });
      expect(r.status).toBe(200);
    }
    const r3 = await fetch(`${dev.base}/api/branches/${b3}/endpoint/start`, { method: "POST" });
    expect(r3.status).toBe(409);
    const body = await r3.json();
    expect(body.error).toContain("main");
    expect(body.error).toContain("DEVDB_PORT_RANGE");
  });
});
