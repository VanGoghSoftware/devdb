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
    // Task 3 (DTO mappers): the wire response must never carry the branch's internal password —
    // agents use mainBranch.connectionString instead.
    expect(mainBranch.password).toBeUndefined();
    expect(mainBranch.connectionString === null || typeof mainBranch.connectionString === "string").toBe(true);
    // Fix 3 (task-3 coverage): the other internal-only columns (BranchRow's stickyPort/
    // importStatus/importError) must be equally absent from the real REST response, not just
    // password — proves toBranchDto's redaction end-to-end against the live daemon, not only
    // against unit-level fakes.
    expect((mainBranch as Record<string, unknown>).stickyPort).toBeUndefined();
    expect((mainBranch as Record<string, unknown>).importStatus).toBeUndefined();
    expect((mainBranch as Record<string, unknown>).importError).toBeUndefined();

    const del = await fetch(`${dev.base}/api/projects/${project.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const list = await (await fetch(`${dev.base}/api/projects`)).json();
    expect(list).toHaveLength(0);

    // Confirm the engine tenant is actually torn down, not just the local state rows — probe
    // the pageserver directly (same container, same network namespace as the daemon) since the
    // daemon's own REST surface has no route to ask the engine this question.
    const probe = await dev.container.exec([
      "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
      `http://127.0.0.1:9898/v1/tenant/${project.id}`,
    ]);
    expect(probe.output.trim()).toBe("404");
  });
});
