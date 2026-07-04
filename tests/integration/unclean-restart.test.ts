import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execa } from "execa";
import { startDevdb, type Devdb } from "./helpers/container.js";

// The storage-controller's embedded postgres (storcon_db) writes a postmaster.pid into its data
// dir on the persistent /data volume. An unclean container stop (docker kill / OOM / host reboot)
// skips the daemon's SIGTERM shutdown path — under which storcon_db is stopped last and postgres
// deletes its own pid file — so the pid file is orphaned. On the next boot, container PID reuse can
// make the dead postmaster's recorded PID look alive to postgres's stale-lock heuristic, and
// postgres then refuses to start ("lock file already exists" → FATAL → the whole boot fails).
//
// EmbeddedPostgres.start() now removes a stale postmaster.pid before launching (safe: the daemon
// holds the exclusive /data/.lock by then). This asserts the end-to-end recovery. Note the FATAL
// itself is a PID-reuse RACE (a fresh dir's initdb burns enough PIDs that the recorded PID usually
// outlives the next boot's range, so postgres self-heals — the FATAL only bites once two boots both
// skip initdb), so this test does NOT rely on reproducing the FATAL. Instead it asserts the two
// deterministic outcomes of the fix: the container reboots healthy, AND the daemon logs that it
// removed the stale pid — the log fires whenever the orphaned file is present, race or no race.
describe("unclean restart resilience (stale storcon_db postmaster.pid)", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  const PID_PATH = "/data/daemon_data/storage_controller_pg_data/postmaster.pid";

  it("reboots clean after an unclean stop orphans storcon_db's postmaster.pid, and logs the removal", async () => {
    const id = dev.container.getId();

    // A healthy boot means storcon_db is running, so its postmaster.pid (the data-dir lock) is
    // present on the volume — the exact artifact an unclean stop will orphan below.
    const pidPresent = await execa("docker", ["exec", id, "sh", "-c", `test -f ${PID_PATH} && echo yes || echo no`]);
    expect(pidPresent.stdout.trim()).toBe("yes");

    // ...and the unix socket is disabled (TCP-only), so storcon_db creates NO /tmp/.s.PGSQL.5431[.lock].
    // That socket lock records the same postmaster PID as postmaster.pid and, on a same-container
    // restart (/tmp persists), would be an identical stale-lock boot blocker — disabling the socket
    // removes the file class, so removing postmaster.pid alone cannot merely relocate the FATAL onto it.
    const sockCount = await execa("docker", ["exec", id, "sh", "-c",
      "ls -d /tmp/.s.PGSQL.5431 /tmp/.s.PGSQL.5431.lock 2>/dev/null | wc -l"]);
    expect(sockCount.stdout.trim()).toBe("0");

    // Clear the sibling stale-/data/.lock guard the SAME unclean stop would also leave behind, in one
    // step — this is the documented manual recovery (index.ts prints the exact command), and it is
    // what lets the coming reboot get PAST that guard to actually reach storcon_db.start() and
    // exercise the pid-file fix. Safe to remove live: the daemon only creates /data/.lock as a marker
    // (open "wx" then immediately close — it holds no fd) and re-reads it solely at boot.
    await execa("docker", ["exec", id, "rm", "-f", "/data/.lock"]);

    // Ungraceful reboot: a 0s stop grace period is an effectively-immediate SIGKILL, skipping the
    // SIGTERM shutdown path — so storcon_db postgres is killed with its postmaster.pid still on disk,
    // then the container boots again. (testcontainers treats sub-second timeouts as a 0s grace.)
    await dev.restart({ timeout: 100 });

    // Without the fix this boot would (intermittently) FATAL in storcon_db and the daemon would
    // exit(1) — the container would never report healthy. With the fix, the stale pid is removed
    // first and the engine comes all the way up.
    let healthy = false;
    for (let i = 0; i < 90; i++) {
      try {
        const s = await fetch(`${dev.base}/api/status`);
        if (s.ok && (await s.json()).healthy) { healthy = true; break; }
      } catch { /* container still coming back up */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(healthy).toBe(true);

    // Deterministic proof the fix's path actually ran on this boot (the FATAL is a race; this is not):
    // the removal logs through storcon_db's onLine sink, so it lands in `docker logs`. Only the second
    // boot logs it — the first boot's freshly-initdb'd dir has no postgres running yet, so no pid file.
    const logs = await execa("docker", ["logs", id], { reject: false });
    expect(`${logs.stdout}\n${logs.stderr}`).toContain("stale postmaster.pid");
  });
});
