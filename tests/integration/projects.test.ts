import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("projects", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("creates a project with a main branch and deletes it", async () => {
    const res = await fetch(`${dev.base}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "acme" }),
    });
    expect(res.status).toBe(201);
    const { project, mainBranch } = await res.json();
    expect(mainBranch.name).toBe("main");

    const del = await fetch(`${dev.base}/api/projects/${project.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const list = await (await fetch(`${dev.base}/api/projects`)).json();
    expect(list).toHaveLength(0);
  });
});
