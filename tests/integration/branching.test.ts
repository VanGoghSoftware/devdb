import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";
import { api, connect } from "./helpers/pg.js";

describe("branching isolation (the money test)", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("branch sees parent data; writes are isolated both ways", async () => {
    const { project, mainBranch } = await api<{ project: { id: string }; mainBranch: { id: string } }>(
      dev, "POST", "/api/projects", { name: "acme" });

    const mainEp = await api<{ connectionString: string }>(
      dev, "POST", `/api/branches/${mainBranch.id}/endpoint/start`);
    // Regression guard (IPv6-loopback bug): the emitted host must be the IPv4 literal 127.0.0.1,
    // not "localhost" — endpoint ports are published on 127.0.0.1 only, so "localhost" would
    // resolve to ::1 first on IPv6-preferring hosts and refuse external DB clients (SQLSTATE 08001).
    // The connect() below dials that exact host, proving the emitted string is usable as-is.
    expect(new URL(mainEp.connectionString).hostname).toBe("127.0.0.1");
    const main = await connect(dev, mainEp.connectionString);
    await main.query("CREATE TABLE notes (id serial PRIMARY KEY, body text)");
    await main.query("INSERT INTO notes (body) VALUES ('from-main')");

    const branch = await api<{ id: string }>(
      dev, "POST", `/api/projects/${project.id}/branches`, { name: "agent/task-1" });
    const brEp = await api<{ connectionString: string }>(
      dev, "POST", `/api/branches/${branch.id}/endpoint/start`);
    const br = await connect(dev, brEp.connectionString);

    // branch sees parent data
    const seen = await br.query("SELECT body FROM notes");
    expect(seen.rows).toEqual([{ body: "from-main" }]);

    // branch writes don't reach parent
    await br.query("INSERT INTO notes (body) VALUES ('from-branch')");
    expect((await main.query("SELECT count(*)::int AS n FROM notes")).rows[0].n).toBe(1);

    // parent writes after the fork don't reach the branch
    await main.query("INSERT INTO notes (body) VALUES ('main-after-fork')");
    expect((await br.query("SELECT count(*)::int AS n FROM notes")).rows[0].n).toBe(2);

    await main.end();
    await br.end();
  });
});
