import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EmbeddedPostgres, parsePgVersionFileMajor, parsePostgresVersionMajor, resolveVanillaPgDir,
} from "../src/engine/embedded-postgres.js";

describe("EmbeddedPostgres", () => {
  it("builds connection uri", () => {
    const pgInstallDir = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(pgInstallDir, "v17"));
    const pg = new EmbeddedPostgres({
      name: "storcon-db", dataDir: "/tmp/x", pgInstallDir, port: 5431, password: "s3cret",
    });
    expect(pg.connectionUri()).toBe("postgresql://devdb:s3cret@127.0.0.1:5431/postgres");
  });

  it("resolveVanillaPgDir prefers vanilla_v17, falls back to highest v<N>", () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v16"));
    mkdirSync(join(root, "v17"));
    expect(resolveVanillaPgDir(root)).toBe(join(root, "v17"));
    mkdirSync(join(root, "vanilla_v17"));
    expect(resolveVanillaPgDir(root)).toBe(join(root, "vanilla_v17"));
  });

  it("percent-encodes the password in the connection uri", () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v17"));
    const pg = new EmbeddedPostgres({
      name: "x", dataDir: "/tmp/x", pgInstallDir: root, port: 5431, password: "p@ss:w/rd?#%",
    });
    const url = new URL(pg.connectionUri());
    expect(decodeURIComponent(url.password)).toBe("p@ss:w/rd?#%");
    expect(url.hostname).toBe("127.0.0.1");
  });

  it("start() refuses when a process is already running", async () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v17"));
    const pg = new EmbeddedPostgres({
      name: "guarded", dataDir: "/tmp/x", pgInstallDir: root, port: 5431, password: "pw",
    });
    (pg as unknown as { proc: { state: string } }).proc = { state: "running" };
    await expect(pg.start()).rejects.toThrow(/already running/);
  });

  // An unclean container stop (docker kill / OOM / host reboot — anything skipping the SIGTERM
  // path that lets postgres exit cleanly and delete its own pid file) leaves a stale postmaster.pid
  // on the persistent data dir. On the next boot, container PID reuse can make the dead postmaster's
  // recorded PID look alive to postgres's stale-lock heuristic, so postgres refuses to start
  // ("lock file already exists" → FATAL → boot fails). start() must clear it first — safe because
  // the daemon holds the exclusive /data/.lock by this point, so nothing else can own the data dir.
  it("start() removes a stale postmaster.pid before launching postgres", async () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v17")); // resolves as pgDir; its bin/postgres won't exist → spawn ENOENT
    const dataDir = mkdtempSync(join(tmpdir(), "pgdata-"));
    const pidFile = join(dataDir, "postmaster.pid");
    // A realistic postmaster.pid: line 1 is the (now-dead) postmaster PID postgres's check reads.
    writeFileSync(pidFile, "18\n/data/daemon_data/storage_controller_pg_data\n1783166623\n");
    const pg = new EmbeddedPostgres({
      name: "storcon_db", dataDir, pgInstallDir: root, port: 5431, password: "pw",
    });

    // The bogus postgres binary makes ManagedProcess.start() reject (ENOENT) — but the stale-pid
    // removal runs before the spawn, so the file is gone regardless of the launch failing.
    await expect(pg.start()).rejects.toThrow();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("start() tolerates a data dir with no postmaster.pid (force unlink is a no-op)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v17"));
    const dataDir = mkdtempSync(join(tmpdir(), "pgdata-"));
    expect(existsSync(join(dataDir, "postmaster.pid"))).toBe(false);
    const pg = new EmbeddedPostgres({
      name: "storcon_db", dataDir, pgInstallDir: root, port: 5431, password: "pw",
    });

    // The removal must be a no-op when absent (rm force), so the only failure is the bogus-binary
    // spawn — whose error carries the process name; an ENOENT thrown by the unlink itself would not.
    await expect(pg.start()).rejects.toThrow(/storcon_db/);
  });

  it("start() does not touch postmaster.pid when already running (guard precedes removal)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v17"));
    const dataDir = mkdtempSync(join(tmpdir(), "pgdata-"));
    const pidFile = join(dataDir, "postmaster.pid");
    writeFileSync(pidFile, "4321\n");
    const pg = new EmbeddedPostgres({
      name: "guarded", dataDir, pgInstallDir: root, port: 5431, password: "pw",
    });
    // A live child this instance already started: the already-running guard must fire BEFORE the
    // stale-pid removal, so we never yank the pid file out from under our own live postmaster.
    (pg as unknown as { proc: { state: string } }).proc = { state: "running" };

    await expect(pg.start()).rejects.toThrow(/already running/);
    expect(existsSync(pidFile)).toBe(true); // preserved — removal was never reached
  });

  it("start() rejects a concurrent second call even with a stale pid present (guard→claim stays atomic)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v17"));
    const dataDir = mkdtempSync(join(tmpdir(), "pgdata-"));
    // A stale pid IS present — its removal must stay synchronous so it can't insert an await between
    // the running-guard and the this.proc claim, which would let both concurrent starts through.
    writeFileSync(join(dataDir, "postmaster.pid"), "18\n");
    const pg = new EmbeddedPostgres({
      name: "storcon_db", dataDir, pgInstallDir: root, port: 5431, password: "pw",
    });

    // first claims this.proc synchronously (proc.start() sets "starting") before it suspends; the
    // second call must therefore see "starting" and reject, so only ONE ManagedProcess is claimed.
    const first = pg.start();
    const second = pg.start();
    await Promise.all([
      expect(second).rejects.toThrow(/already (starting|running)/),
      expect(first).rejects.toThrow(), // bogus postgres binary — the first still fails to launch
    ]);
  });

  it("init() skips when PG_VERSION exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v17"));
    const dataDir = mkdtempSync(join(tmpdir(), "pgdata-"));
    writeFileSync(join(dataDir, "PG_VERSION"), "17");
    const pg = new EmbeddedPostgres({
      name: "skip", dataDir, pgInstallDir: root, port: 5431, password: "pw",
    });
    await expect(pg.init()).resolves.toBeUndefined();
  });

  it("init() clears an interrupted (PG_VERSION-less) data dir before initdb", async () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v17"));
    const dataDir = mkdtempSync(join(tmpdir(), "pgdata-"));
    const junk = join(dataDir, "leftover.file");
    writeFileSync(junk, "partial init debris");
    const pg = new EmbeddedPostgres({
      name: "recover", dataDir, pgInstallDir: root, port: 5431, password: "pw",
    });
    await expect(pg.init()).rejects.toThrow(); // bogus initdb binary (ENOENT) — expected
    expect(existsSync(junk)).toBe(false); // debris was cleared before the attempt
  });

  it("concurrent init() calls share one in-flight attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v17"));
    const dataDir = mkdtempSync(join(tmpdir(), "pgdata-"));
    const pg = new EmbeddedPostgres({
      name: "dedupe", dataDir, pgInstallDir: root, port: 5431, password: "pw",
    });
    const a = pg.init();
    const b = pg.init();
    expect(a).toBe(b);
    await expect(a).rejects.toThrow(); // bogus initdb — both share the same rejection
  });

  it("parses the catalog major from a PG_VERSION file (leading integer of the first token)", () => {
    expect(parsePgVersionFileMajor("17\n")).toBe(17);
    expect(parsePgVersionFileMajor("19devel\n")).toBe(19); // a dev-build catalog (neon's vanilla)
    expect(parsePgVersionFileMajor("  16  ")).toBe(16);
    expect(parsePgVersionFileMajor("")).toBeNull();
    expect(parsePgVersionFileMajor("garbage")).toBeNull();
  });

  it("parses the major from `postgres --version` output (upstream, dev, and neon-fork formats)", () => {
    expect(parsePostgresVersionMajor("postgres (PostgreSQL) 17.5")).toBe(17);           // true upstream
    expect(parsePostgresVersionMajor("postgres (PostgreSQL) 19devel")).toBe(19);        // neon vanilla dev
    expect(parsePostgresVersionMajor("postgres (PostgreSQL) 17.5 (a1b2c3d)")).toBe(17); // neon fork
    expect(parsePostgresVersionMajor("nonsense")).toBeNull();
  });

  // The cutover this guards (initiative-A Phase 2): repointing devdb:dev onto the self-built
  // true-vanilla 17.5 strands a PRE-EXISTING volume whose storcon catalog was initdb'd by neond's
  // vanilla (19devel). Postgres refuses a data dir from another major with a cryptic FATAL loop;
  // start() must instead refuse BEFORE spawning, with an actionable message naming both majors and
  // the recovery options.
  it("start() refuses when PG_VERSION's major differs from the shipped binary's, before spawning", async () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v17"));
    const dataDir = mkdtempSync(join(tmpdir(), "pgdata-"));
    writeFileSync(join(dataDir, "PG_VERSION"), "19devel\n"); // catalog created by neond's vanilla
    const pg = new EmbeddedPostgres({
      name: "storcon_db", dataDir, pgInstallDir: root, port: 5431, password: "pw",
      probeBinaryMajor: async () => 17, // the self-built true-vanilla this image now ships
    });

    const err = await pg.start().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("PostgreSQL 19"); // found — the volume's catalog major
    expect(msg).toContain("PostgreSQL 17"); // expected — this image's binary major
    expect(msg).toMatch(/fresh volume/);
    expect(msg).toMatch(/previous image/);
    expect(msg).toMatch(/import\/export \(Phase 4\)/);
    // Refused BEFORE spawning: no ManagedProcess was ever claimed, so state stayed "stopped" (a
    // spawn attempt against the bogus binary would have flipped it to "failed").
    expect(pg.state).toBe("stopped");
  });

  it("start() proceeds normally when PG_VERSION's major matches the shipped binary", async () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v17"));
    const dataDir = mkdtempSync(join(tmpdir(), "pgdata-"));
    writeFileSync(join(dataDir, "PG_VERSION"), "17\n");
    const pg = new EmbeddedPostgres({
      name: "storcon_db", dataDir, pgInstallDir: root, port: 5431, password: "pw",
      probeBinaryMajor: async () => 17,
    });
    // A matching major clears the guard, so the ONLY failure is the bogus-binary spawn — whose error
    // carries the process name (the guard's actionable message never mentions "spawn"/the name alone).
    await expect(pg.start()).rejects.toThrow(/storcon_db/);
  });

  it("start() proceeds on a fresh data dir with no PG_VERSION (the guard is skipped entirely)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v17"));
    const dataDir = mkdtempSync(join(tmpdir(), "pgdata-"));
    expect(existsSync(join(dataDir, "PG_VERSION"))).toBe(false);
    // The probe THROWS if ever consulted — proving the fresh-initdb path never resolves the expected
    // major at all (there is nothing to compare a missing PG_VERSION against).
    const pg = new EmbeddedPostgres({
      name: "storcon_db", dataDir, pgInstallDir: root, port: 5431, password: "pw",
      probeBinaryMajor: async () => { throw new Error("probe must not run when PG_VERSION is absent"); },
    });
    await expect(pg.start()).rejects.toThrow(/storcon_db/); // only the bogus-binary spawn fails
  });
});
