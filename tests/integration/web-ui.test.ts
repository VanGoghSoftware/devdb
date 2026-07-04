import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("web UI serving", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("serves the app shell at /", async () => {
    const res = await fetch(`${dev.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('id="root"');
  });

  it("serves the fingerprinted assets referenced by index.html", async () => {
    const html = await (await fetch(`${dev.base}/`)).text();
    const assetPath = html.match(/\/assets\/[^"]+\.js/)?.[0];
    expect(assetPath).toBeTruthy();
    const assetRes = await fetch(`${dev.base}${assetPath}`);
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("content-type")).toMatch(/javascript/);
  });

  it("SPA-falls-back on deep links but keeps unknown API routes as JSON 404", async () => {
    const deep = await fetch(`${dev.base}/projects/00000000-0000-0000-0000-000000000000`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('id="root"');
    const apiMiss = await fetch(`${dev.base}/api/definitely-not-a-route`);
    expect(apiMiss.status).toBe(404);
    expect(apiMiss.headers.get("content-type")).toContain("application/json");
  });
});
