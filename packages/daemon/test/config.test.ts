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
  it("rejects non-decimal http port syntax", () => {
    expect(() => loadConfig({ ...base, DEVDB_HTTP_PORT: "0x1130" })).toThrow(/DEVDB_HTTP_PORT/);
    expect(() => loadConfig({ ...base, DEVDB_HTTP_PORT: "4.4e3" })).toThrow(/DEVDB_HTTP_PORT/);
  });
  it("rejects whitespace-only path vars", () => {
    expect(() => loadConfig({ ...base, DEVDB_DATA_DIR: "   " })).toThrow(/DEVDB_DATA_DIR/);
  });
  it("trims path vars", () => {
    expect(loadConfig({ ...base, DEVDB_DATA_DIR: "  /data  " }).dataDir).toBe("/data");
  });
  it("rejects ranges overlapping reserved engine ports", () => {
    expect(() => loadConfig({ ...base, DEVDB_PORT_RANGE: "63990-64010" })).toThrow(/64000/);
  });
  it("rejects http port inside the endpoint range", () => {
    expect(() => loadConfig({ ...base, DEVDB_HTTP_PORT: "54310" })).toThrow(/54310/);
  });
  it("rejects ranges overlapping the tracer/control-plane port 4318", () => {
    expect(() => loadConfig({ ...base, DEVDB_PORT_RANGE: "4310-4320" })).toThrow(/4318/);
  });
  it("exposes the tracer sink port (4318)", () => {
    expect(loadConfig(base).engine.tracerPort).toBe(4318);
  });

  describe("DEVDB_WEB_DIST", () => {
    it("is null when unset", () => {
      expect(loadConfig(base).webDistDir).toBeNull();
    });
    it("is null when whitespace-only", () => {
      expect(loadConfig({ ...base, DEVDB_WEB_DIST: "   " }).webDistDir).toBeNull();
    });
    it("rejects a relative value", () => {
      expect(() => loadConfig({ ...base, DEVDB_WEB_DIST: "packages/web/dist" })).toThrow(
        /DEVDB_WEB_DIST/,
      );
    });
    it("passes through an absolute value", () => {
      expect(loadConfig({ ...base, DEVDB_WEB_DIST: "/app/packages/web/dist" }).webDistDir).toBe(
        "/app/packages/web/dist",
      );
    });
  });

  it("pg build provisioning defaults + derived dirs (GHCR by default; token unset)", () => {
    const cfg = loadConfig(base);
    // initiative-A P2-A1: the default registry is now private GHCR; the template is a REPO PATH (no host).
    expect(cfg.pgRegistryBase).toBe("https://ghcr.io");
    expect(cfg.pgImageTemplate).toBe("vangoghsoftware/worktreedb-compute-v{major}");
    expect(cfg.pgRegistryToken).toBeUndefined(); // no credential unless DEVDB_PG_REGISTRY_TOKEN is set
    expect(cfg.pgBuildsDir).toBe(`${cfg.dataDir}/pg_builds`);
    expect(cfg.pgDistribDir).toBe(`${cfg.dataDir}/pg_distrib`);
  });

  it("DEVDB_PG_REGISTRY_TOKEN parses into pgRegistryToken; empty/whitespace normalizes to undefined", () => {
    expect(loadConfig({ ...base, DEVDB_PG_REGISTRY_TOKEN: "ghp_secret-pat" }).pgRegistryToken).toBe("ghp_secret-pat");
    expect(loadConfig({ ...base, DEVDB_PG_REGISTRY_TOKEN: "  ghp_trimmed  " }).pgRegistryToken).toBe("ghp_trimmed");
    expect(loadConfig({ ...base, DEVDB_PG_REGISTRY_TOKEN: "" }).pgRegistryToken).toBeUndefined();
    expect(loadConfig({ ...base, DEVDB_PG_REGISTRY_TOKEN: "   " }).pgRegistryToken).toBeUndefined();
  });

  it("registry base + template stay overridable back to Docker Hub (GHCR-down / mirror fallback)", () => {
    const cfg = loadConfig({
      ...base,
      DEVDB_PG_REGISTRY_BASE: "https://registry-1.docker.io",
      DEVDB_PG_IMAGE_TEMPLATE: "neondatabase/compute-node-v{major}",
    });
    expect(cfg.pgRegistryBase).toBe("https://registry-1.docker.io");
    expect(cfg.pgImageTemplate).toBe("neondatabase/compute-node-v{major}");
  });

  it("DEVDB_PG_REGISTRY_BASE must be an http(s) URL; trailing slash stripped", () => {
    expect(() => loadConfig({ ...base, DEVDB_PG_REGISTRY_BASE: "ftp://nope" })).toThrow(
      /DEVDB_PG_REGISTRY_BASE/,
    );
    expect(
      loadConfig({ ...base, DEVDB_PG_REGISTRY_BASE: "http://pgregistry:5000/" }).pgRegistryBase,
    ).toBe("http://pgregistry:5000");
  });

  it("DEVDB_PG_IMAGE_TEMPLATE must contain {major}", () => {
    expect(() =>
      loadConfig({ ...base, DEVDB_PG_IMAGE_TEMPLATE: "neondatabase/compute-node" }),
    ).toThrow(/\{major\}/);
  });
});
