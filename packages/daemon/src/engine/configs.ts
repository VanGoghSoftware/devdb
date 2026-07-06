import { join } from "node:path";
import type { DevdbConfig } from "../config.js";

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function engineDirs(cfg: DevdbConfig) {
  return {
    pageserverDir: join(cfg.dataDir, "pageserver"),
    pageserverLayers: join(cfg.dataDir, "pageserver_1"),
    safekeeperDir: join(cfg.dataDir, "safekeeper"),
    storconDbDir: join(cfg.dataDir, "daemon_data", "storage_controller_pg_data"),
    logsDir: join(cfg.dataDir, "logs"),
    computesDir: join(cfg.dataDir, "computes"),
  };
}

// oracle: neon control_plane/src/pageserver.rs pageserver_init_make_toml (auth keys omitted — trust mode, see Task 7 note)
// Trust-mode deviation (spec decision #7 detail): control_plane conditionally enables NeonJWT auth
// on every engine component when configured. DevDB omits ALL of it: engine ports bind to 127.0.0.1
// inside the container and upstream neon_local runs this exact stack in trust mode by default.
// pg_distrib_dir points at the daemon-composed symlink dir (builds/pgdistrib.ts) — baked majors
// stay baked; downloaded-only majors resolve for walredo.
export function pageserverToml(cfg: DevdbConfig): string {
  const layers = engineDirs(cfg).pageserverLayers;
  return [
    `availability_zone = "devdb-1"`,
    `pg_distrib_dir = ${tomlString(cfg.pgDistribDir)}`,
    `broker_endpoint = "http://127.0.0.1:${cfg.engine.brokerPort}/"`,
    `listen_pg_addr = "127.0.0.1:${cfg.engine.pageserverPgPort}"`,
    `listen_http_addr = "127.0.0.1:${cfg.engine.pageserverHttpPort}"`,
    `control_plane_api = "http://127.0.0.1:${cfg.engine.storconPort}/upcall/v1/"`,
    ``,
    `[remote_storage]`,
    `local_path = ${tomlString(layers)}`,
    ``,
    `[disk_usage_based_eviction]`,
    `enabled = true`,
    `max_usage_pct = 100`,
    `min_avail_bytes = 2000000000`,
    ``,
  ].join("\n");
}

export function pageserverIdentityToml(): string {
  return "id = 1\n"; // oracle: identity.toml content — "id = 1"
}

export function pageserverMetadataJson(cfg: DevdbConfig): string {
  // oracle: neon control_plane/src/pageserver.rs start() metadata.json write → pageserver_api::config::NodeMetadata
  return JSON.stringify({
    host: "127.0.0.1",
    http_host: "127.0.0.1",
    http_port: cfg.engine.pageserverHttpPort,
    port: cfg.engine.pageserverPgPort,
  });
}

export interface ProcessSpec {
  name: string; bin: string; args: string[]; readyNeedle: string;
}

export function brokerSpec(cfg: DevdbConfig): ProcessSpec {
  // oracle: neon control_plane/src/broker.rs start()
  // (trust mode: the broker takes no auth flags in the oracle either — nothing to omit)
  return {
    name: "storage_broker",
    bin: join(cfg.neonBinDir, "storage_broker"),
    args: ["-l", `127.0.0.1:${cfg.engine.brokerPort}`],
    readyNeedle: "listening",
  };
}

export function storconSpec(cfg: DevdbConfig, dbUri: string): ProcessSpec {
  // oracle: neon control_plane/src/storage_controller.rs start() (JWT args omitted — trust mode)
  return {
    name: "storage_controller",
    bin: join(cfg.neonBinDir, "storage_controller"),
    args: [
      "-l", `127.0.0.1:${cfg.engine.storconPort}`,
      "--database-url", dbUri,
      "--dev",
      "--timeline-safekeeper-count", "1",
      "--timelines-onto-safekeepers",
      "--control-plane-url", "http://127.0.0.1:4318",
    ],
    readyNeedle: `Serving HTTP on 127.0.0.1:${cfg.engine.storconPort}`,
  };
}

export function safekeeperSpec(cfg: DevdbConfig): ProcessSpec {
  // oracle: neon control_plane/src/safekeeper.rs start() (auth key paths omitted — trust mode)
  return {
    name: "safekeeper",
    bin: join(cfg.neonBinDir, "safekeeper"),
    args: [
      "-D", engineDirs(cfg).safekeeperDir,
      "--id", "1",
      "--broker-endpoint", `http://127.0.0.1:${cfg.engine.brokerPort}`,
      "--listen-pg", `127.0.0.1:${cfg.engine.safekeeperPgPort}`,
      "--listen-http", `127.0.0.1:${cfg.engine.safekeeperHttpPort}`,
      "--availability-zone", "devdb-1",
    ],
    readyNeedle: "starting safekeeper WAL service on",
  };
}

export function pageserverSpec(cfg: DevdbConfig): ProcessSpec {
  // oracle: neon control_plane/src/pageserver.rs start() (NEON_AUTH_TOKEN omitted — trust mode)
  return {
    name: "pageserver",
    bin: join(cfg.neonBinDir, "pageserver"),
    args: ["-D", engineDirs(cfg).pageserverDir],
    readyNeedle: `Starting pageserver http handler on 127.0.0.1:${cfg.engine.pageserverHttpPort}`,
  };
}

export function safekeeperRegistrationBody(cfg: DevdbConfig, nowIso: string): object {
  // oracle: neon control_plane/src/storage_controller.rs register_safekeepers body shape
  return {
    id: 1, region_id: "devdb-1", host: "127.0.0.1",
    port: cfg.engine.safekeeperPgPort, http_port: cfg.engine.safekeeperHttpPort,
    version: 1, availability_zone_id: "devdb-1", created_at: nowIso, updated_at: nowIso,
  };
}
