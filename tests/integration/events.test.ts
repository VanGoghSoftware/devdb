import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";
import { connectSse, nextMatching } from "./helpers/sse.js";

describe("/api/events invalidation channel", () => {
  let dev: Devdb;
  const ac = new AbortController();
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { ac.abort(); await dev?.stop(); });

  it("streams project/branch/endpoint lifecycle + rename as typed events", async () => {
    const gen = await connectSse(`${dev.base}/api/events`, ac.signal);

    // project.created
    const pRes = await fetch(`${dev.base}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "events-proj" }),
    });
    expect(pRes.status).toBe(201);
    const { project } = await pRes.json();
    const created = JSON.parse(await nextMatching(gen, (p) => p.includes('"project.created"')));
    expect(created).toMatchObject({ type: "project.created", projectId: project.id });

    // branch.created
    const bRes = await fetch(`${dev.base}/api/projects/${project.id}/branches`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "dev" }),
    });
    expect(bRes.status).toBe(201);
    const branch = await bRes.json();
    const bEvt = JSON.parse(await nextMatching(gen, (p) => p.includes('"branch.created"')));
    expect(bEvt).toMatchObject({ type: "branch.created", projectId: project.id, branchId: branch.id });

    // endpoint.status sequence on start (starting → running at minimum)
    const sRes = await fetch(`${dev.base}/api/branches/${branch.id}/endpoint/start`, { method: "POST" });
    expect(sRes.status).toBe(200);
    const esEvt = JSON.parse(await nextMatching(gen, (p) => {
      try { const e = JSON.parse(p); return e.type === "endpoint.status" && e.branchId === branch.id; }
      catch { return false; }
    }));
    expect(esEvt).toMatchObject({ type: "endpoint.status", branchId: branch.id });

    // rename → branch.updated + round-trip visible via GET
    const rRes = await fetch(`${dev.base}/api/branches/${branch.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "dev-renamed" }),
    });
    expect(rRes.status).toBe(200);
    const uEvt = JSON.parse(await nextMatching(gen, (p) => p.includes('"branch.updated"')));
    expect(uEvt).toMatchObject({ type: "branch.updated", branchId: branch.id });
    const got = await (await fetch(`${dev.base}/api/branches/${branch.id}`)).json();
    expect(got.name).toBe("dev-renamed");
    expect(got.slug).toBe(branch.slug); // immutable

    // root branch rename refused
    const branches = await (await fetch(`${dev.base}/api/projects/${project.id}/branches`)).json();
    const main = branches.find((b: { parentBranchId: string | null }) => b.parentBranchId === null);
    const rootRename = await fetch(`${dev.base}/api/branches/${main.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "primary" }),
    });
    expect(rootRename.status).toBe(400);
  }, 120_000);
});
