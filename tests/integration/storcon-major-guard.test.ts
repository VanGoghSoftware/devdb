import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execa } from "execa";
import { startDevdb, type Devdb } from "./helpers/container.js";

// initiative-A Phase 2, Task 7b. Repointing devdb:dev onto the self-built true-vanilla Postgres
// 17.5 strands a PRE-EXISTING /data volume whose storage_controller catalog (storcon_db) was
// initdb'd by neond's vanilla — a DIFFERENT major (19devel). Postgres refuses to open a data dir
// from another major with a cryptic FATAL loop; EmbeddedPostgres.start() now detects the mismatch
// at boot (the data dir's PG_VERSION major vs the shipped binary's) and refuses with an actionable
// message instead. The fresh-volume suite structurally cannot reach that path, so this manufactures
// the mismatch deterministically by rewriting PG_VERSION on an already-booted volume — no binaries
// of the foreign major are required, because the version FILE alone drives the check.
const STORCON_PG_VERSION = "/data/daemon_data/storage_controller_pg_data/PG_VERSION";

describe("storcon-catalog major guard (refuse a pre-existing volume from a foreign PG major)", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("boots healthy on a fresh volume, then refuses to boot after PG_VERSION is rewritten to a foreign major", async () => {
    const id = dev.container.getId();

    // Baseline: a fresh volume booted healthy (startDevdb's wait strategy already required
    // /api/status 200), so storcon_db's initdb stamped PG_VERSION on the persistent volume — the
    // exact file whose major the guard reads on the next boot.
    const before = await execa("docker", ["exec", id, "cat", STORCON_PG_VERSION]);
    expect(before.stdout.trim().length).toBeGreaterThan(0);

    // Simulate a pre-existing volume whose storcon catalog was created by a DIFFERENT postgres major
    // than this image ships. 99 is chosen to differ from BOTH the current neond-engine image's
    // storcon major (19devel) AND the post-repoint self-built major (17.5), so the mismatch is real
    // whichever engine devdb:dev is built from on this branch — and it needs no PG-99 binaries.
    await execa("docker", ["exec", id, "sh", "-c", `printf '99\\n' > ${STORCON_PG_VERSION}`]);

    // Defensive, mirroring unclean-restart.test.ts: clear the single-instance lock so the reboot
    // cannot be blocked by it regardless of shutdown timing — this test is about the catalog guard,
    // not the lock. (A clean `docker restart` shutdown removes it anyway; this just isolates intent.)
    await execa("docker", ["exec", id, "rm", "-f", "/data/.lock"]);

    // A normal restart — the real upgrade path (`docker compose up -d` onto a new image over the old
    // volume). Raw `docker restart` with a generous stop grace, NOT dev.restart(): this boot is
    // EXPECTED to fail, so re-running testcontainers' HTTP-200 wait strategy would only time out.
    await execa("docker", ["restart", "-t", "25", id]);

    // The guard throws during boot → index.ts logs "boot failed: …" to stderr and process.exit(1) →
    // the container exits. Poll (bounded) until it has exited, accumulating its logs.
    let logs = "";
    let running = true;
    for (let i = 0; i < 60; i++) {
      const out = await execa("docker", ["logs", id], { reject: false });
      logs = `${out.stdout}\n${out.stderr}`;
      const state = await execa("docker", ["inspect", "-f", "{{.State.Running}}", id], { reject: false });
      running = state.stdout.trim() !== "false";
      if (!running && logs.includes("storage_controller catalog was created")) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Actionable refusal — names the found major (99), points at both recovery options, and cites
    // the Phase-4 migration path — instead of a cryptic postgres FATAL loop.
    expect(logs).toContain("storage_controller catalog was created by PostgreSQL 99");
    expect(logs).toMatch(/fresh volume/);
    expect(logs).toMatch(/previous image/);
    expect(logs).toContain("import/export (Phase 4)");
    // And it must actually STOP the boot, not limp on.
    expect(running).toBe(false);
  });
});
