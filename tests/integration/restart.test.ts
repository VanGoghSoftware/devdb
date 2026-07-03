import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";
import { api, connect } from "./helpers/pg.js";

describe("restart resilience", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("branches survive a container restart; endpoint statuses reconcile", async () => {
    const created = await api<{ mainBranch: { id: string } }>(dev, "POST", "/api/projects", { name: "acme" });
    const mainId = created.mainBranch.id;

    const ep = await api<{ connectionString: string }>(
      dev, "POST", `/api/branches/${mainId}/endpoint/start`);
    const c = await connect(dev, ep.connectionString);
    await c.query("CREATE TABLE keep (v text)");
    await c.query("INSERT INTO keep VALUES ('survives')");
    await c.end();

    // dev.restart() (not dev.container.restart() directly) — see helpers/container.ts's
    // documented testcontainers restart()-port-cache race: on this image (11 exposed ports),
    // testcontainers occasionally throws "No host port found for host IP" from a stale internal
    // inspect that races Docker's own (fast, correct) port republishing. dev.restart() confirms
    // the container is genuinely back via an independent live check before treating that specific
    // throw as fatal, and refreshes dev's OWN port cache either way so dev.base below is correct.
    await dev.restart({ timeout: 60 });
    // Wait for healthy again — same boot-wait pattern integration tests use elsewhere for a
    // fresh container start (Wait.forHttp in helpers/container.ts), reimplemented here as a
    // bounded poll since testcontainers' own wait strategy only runs on the initial `.start()`,
    // not on a restart of an already-started container.
    let healthy = false;
    for (let i = 0; i < 120; i++) {
      try {
        const s = await fetch(`${dev.base}/api/status`);
        if (s.ok && (await s.json()).healthy) { healthy = true; break; }
      } catch { /* container coming back */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(healthy).toBe(true);

    // Boot reconciliation (T16): the compute that was serving mainId's endpoint died with the
    // old container — ComputeManager starts empty on every boot, so the persisted row must have
    // been reset to "stopped" (port cleared) rather than left claiming "running" for a process
    // that no longer exists.
    const detail = await api<{ endpointStatus: string; port: number | null }>(
      dev, "GET", `/api/branches/${mainId}`);
    expect(detail.endpointStatus).toBe("stopped");
    expect(detail.port).toBeNull();

    // The branch itself — and the data written to it before the restart — must still be usable:
    // timelines survive in the engine (storcon_db + pageserver + safekeeper data all live on the
    // container's persisted volumes), only the compute process and its in-memory bookkeeping die.
    const ep2 = await api<{ connectionString: string }>(
      dev, "POST", `/api/branches/${mainId}/endpoint/start`);
    const c2 = await connect(dev, ep2.connectionString);
    expect((await c2.query("SELECT v FROM keep")).rows).toEqual([{ v: "survives" }]);
    await c2.end();
  });
});
