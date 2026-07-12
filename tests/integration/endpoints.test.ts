import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_PREFIX, startDevdb, type Devdb } from "./helpers/container.js";

describe("endpoint port exhaustion", () => {
  let dev: Devdb;
  beforeAll(async () => {
    dev = await startDevdb({ DEVDB_PORT_RANGE: "54300-54301" });
  });
  afterAll(async () => { await dev?.stop(); });

  it("names running endpoints when the range is full, and live stop frees capacity for reuse", async () => {
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
    // project-qualified (projectName/branchName) — not the bare branch name — so a 409 spanning
    // multiple projects' "main" branches doesn't read as an ambiguous "main, main".
    expect(body.error).toContain("p1/main");
    expect(body.error).toContain("p2/main");
    expect(body.error).toContain(`${ENV_PREFIX}PORT_RANGE`);

    // Live coverage: GET reflects the running endpoint, stop actually releases it, and the freed
    // port is reused by the branch that previously 409'd — proving this isn't just a status-flag
    // flip but a real port release back into the exhausted range.
    const g1 = await fetch(`${dev.base}/api/branches/${b1}/endpoint`);
    expect(g1.status).toBe(200);
    const g1Body = await g1.json();
    expect(g1Body.status).toBe("running");
    expect(typeof g1Body.port).toBe("number");
    const capturedPort = g1Body.port as number;

    const stopR = await fetch(`${dev.base}/api/branches/${b1}/endpoint/stop`, { method: "POST" });
    expect(stopR.status).toBe(200);
    const stopBody = await stopR.json();
    expect(stopBody.endpointStatus).toBe("stopped");

    const g1After = await fetch(`${dev.base}/api/branches/${b1}/endpoint`);
    expect(g1After.status).toBe(200);
    const g1AfterBody = await g1After.json();
    expect(g1AfterBody.status).toBe("stopped");
    expect(g1AfterBody.port).toBeNull();

    const r3Retry = await fetch(`${dev.base}/api/branches/${b3}/endpoint/start`, { method: "POST" });
    expect(r3Retry.status).toBe(200);
    const r3RetryBody = await r3Retry.json();
    expect(r3RetryBody.endpointStatus).toBe("running");
    // With a 2-port range and b2 still holding the other slot, b1's just-freed port is the only
    // one available — b3 must claim exactly that port, proving live stop released real capacity.
    expect(r3RetryBody.port).toBe(capturedPort);
  });
});
