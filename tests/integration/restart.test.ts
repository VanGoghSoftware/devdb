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

    // dev.restart() delegates to testcontainers' restart(), which since 11.4.0 waits for all
    // host port bindings to be republished and re-runs the startup wait strategy — the
    // port-cache race this call previously had to defend against is fixed upstream (see the
    // T16 epilogue in helpers/container.ts). timeout is milliseconds since testcontainers 11
    // (60 would truncate to a 0s grace period, i.e. immediate SIGKILL).
    await dev.restart({ timeout: 60_000 });
    // Wait for healthy again. restart() resolving already guarantees /api/status answers 200
    // (the wait strategy re-runs on restart), but that route returns 200 with healthy: false
    // while engine processes are still coming up — this poll waits for the engine itself.
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
