import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  brokerSpec, engineDirs, pageserverIdentityToml, pageserverMetadataJson,
  pageserverSpec, pageserverToml, safekeeperRegistrationBody, safekeeperSpec, storconSpec,
} from "../src/engine/configs.js";

const cfg = loadConfig({
  DEVDB_DATA_DIR: "/data",
  NEON_BINARIES_DIR: "/usr/local/share/neon/bin",
  PG_INSTALL_DIR: "/usr/local/share/neon/pg_install",
});

describe("engine configs", () => {
  it("pageserver.toml matches oracle shape in trust mode", () => {
    const toml = pageserverToml(cfg);
    expect(toml).toContain(`pg_distrib_dir = "/usr/local/share/neon/pg_install"`);
    expect(toml).toContain(`broker_endpoint = "http://127.0.0.1:50051/"`);
    expect(toml).toContain(`listen_pg_addr = "127.0.0.1:64000"`);
    expect(toml).toContain(`listen_http_addr = "127.0.0.1:9898"`);
    expect(toml).toContain(`control_plane_api = "http://127.0.0.1:1234/upcall/v1/"`);
    expect(toml).toContain(`local_path = "/data/pageserver_1"`);
    expect(toml).toContain("[disk_usage_based_eviction]");
    expect(toml).not.toContain("NeonJWT");
  });

  it("identity and metadata match oracle", () => {
    expect(pageserverIdentityToml()).toBe("id = 1\n");
    expect(JSON.parse(pageserverMetadataJson(cfg))).toEqual({
      host: "127.0.0.1", http_host: "127.0.0.1", http_port: 9898, port: 64000,
    });
  });

  it("process specs carry oracle args and needles", () => {
    expect(brokerSpec(cfg).args).toEqual(["-l", "127.0.0.1:50051"]);
    expect(brokerSpec(cfg).readyNeedle).toBe("listening");
    const storcon = storconSpec(cfg, "postgresql://devdb:x@127.0.0.1:5431/postgres");
    expect(storcon.args).toEqual([
      "-l", "127.0.0.1:1234",
      "--database-url", "postgresql://devdb:x@127.0.0.1:5431/postgres",
      "--dev",
      "--timeline-safekeeper-count", "1",
      "--timelines-onto-safekeepers",
      "--control-plane-url", "http://127.0.0.1:4318",
    ]);
    expect(storcon.readyNeedle).toBe("Serving HTTP on 127.0.0.1:1234");
    const sk = safekeeperSpec(cfg);
    expect(sk.args).toEqual([
      "-D", "/data/safekeeper",
      "--id", "1",
      "--broker-endpoint", "http://127.0.0.1:50051",
      "--listen-pg", "127.0.0.1:5454",
      "--listen-http", "127.0.0.1:7676",
      "--availability-zone", "devdb-1",
    ]);
    expect(sk.readyNeedle).toBe("starting safekeeper WAL service on");
    expect(pageserverSpec(cfg).args).toEqual(["-D", "/data/pageserver"]);
    expect(pageserverSpec(cfg).readyNeedle).toBe("Starting pageserver http handler on 127.0.0.1:9898");
  });

  it("safekeeper registration body matches oracle", () => {
    expect(safekeeperRegistrationBody(cfg, "2026-07-02T00:00:00Z")).toEqual({
      id: 1, region_id: "devdb-1", host: "127.0.0.1", port: 5454, http_port: 7676,
      version: 1, availability_zone_id: "devdb-1",
      created_at: "2026-07-02T00:00:00Z", updated_at: "2026-07-02T00:00:00Z",
    });
  });

  it("escapes quotes and backslashes in TOML path values", () => {
    const weird = loadConfig({
      DEVDB_DATA_DIR: '/da"ta',
      NEON_BINARIES_DIR: "/usr/local/share/neon/bin",
      PG_INSTALL_DIR: '/pg\\install',
    });
    const toml = pageserverToml(weird);
    expect(toml).toContain('pg_distrib_dir = "/pg\\\\install"');
    expect(toml).toContain('local_path = "/da\\"ta/pageserver_1"');
  });

  it("rejects relative path env vars", () => {
    expect(() => loadConfig({
      DEVDB_DATA_DIR: "relative/data",
      NEON_BINARIES_DIR: "/bin",
      PG_INSTALL_DIR: "/pg",
    })).toThrow(/DEVDB_DATA_DIR.*absolute/);
  });

  it("metadata and registration ports derive from cfg.engine", () => {
    expect(JSON.parse(pageserverMetadataJson(cfg))).toMatchObject({ http_port: 9898, port: 64000 });
    expect(safekeeperRegistrationBody(cfg, "x")).toMatchObject({ port: 5454, http_port: 7676 });
  });
});
