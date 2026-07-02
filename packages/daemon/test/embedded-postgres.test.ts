import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddedPostgres, resolveVanillaPgDir } from "../src/engine/embedded-postgres.js";

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
});
