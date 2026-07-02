import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  DEVDB_DATA_DIR: "/data",
  NEON_BINARIES_DIR: "/usr/local/share/neon/bin",
  PG_INSTALL_DIR: "/usr/local/share/neon/pg_install",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.httpPort).toBe(4400);
    expect(c.portRange).toEqual({ min: 54300, max: 54339 });
    expect(c.engine.storconPort).toBe(1234);
  });
  it("parses DEVDB_PORT_RANGE", () => {
    const c = loadConfig({ ...base, DEVDB_PORT_RANGE: "60000-60010" });
    expect(c.portRange).toEqual({ min: 60000, max: 60010 });
  });
  it("rejects inverted range", () => {
    expect(() => loadConfig({ ...base, DEVDB_PORT_RANGE: "6000-100" })).toThrow(/PORT_RANGE/);
  });
  it("requires data dir", () => {
    expect(() => loadConfig({})).toThrow(/DEVDB_DATA_DIR/);
  });
});
