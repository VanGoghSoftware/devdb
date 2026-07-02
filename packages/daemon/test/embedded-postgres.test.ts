import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
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
});
