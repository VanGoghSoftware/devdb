import { computePostgresqlConf } from "./pgconf.js";
import { scramSha256Verifier } from "./scram.js";
import { assertEngineId } from "../engine/ids.js";

// oracle: src/mgmt/compute/mod.rs:820-917 generate_config.
// Deviation: storage_auth_token omitted (trust mode).
// VERIFY on first live run (Task 11 step 5): the pageserver_connection_info shards key
// ("0000") — authoritative encoding in neon submodule libs/compute_api/src/spec.rs and
// libs/pageserver_api/src/shard.rs. compute_ctl also honors legacy pageserver_connstring.
export function computeConfigJson(a: {
  tenantIdHex: string; timelineIdHex: string; port: number; hbaPath: string; password: string;
}): string {
  assertEngineId(a.tenantIdHex);
  assertEngineId(a.timelineIdHex);
  const spec = {
    format_version: 1.0,
    features: [],
    cluster: {
      cluster_id: null,
      name: null,
      state: null,
      roles: [{ name: "postgres", encrypted_password: scramSha256Verifier(a.password), options: null }],
      databases: [{ name: "postgres", owner: "postgres", options: null, restrict_conn: false, invalid: false }],
      postgresql_conf: computePostgresqlConf({ port: a.port, hbaPath: a.hbaPath }),
      settings: null,
    },
    delta_operations: null,
    skip_pg_catalog_updates: false,
    tenant_id: a.tenantIdHex,
    timeline_id: a.timelineIdHex,
    pageserver_connection_info: {
      shard_count: 0,
      stripe_size: null,
      shards: {
        "0000": {
          pageservers: [{ id: 1, libpq_url: "postgres://cloud_admin@127.0.0.1:64000", grpc_url: null }],
        },
      },
      prefer_protocol: "libpq",
    },
    pageserver_connstring: "postgres://cloud_admin@127.0.0.1:64000",
    endpoint_id: `compute-${a.timelineIdHex}`,
    safekeeper_connstrings: ["127.0.0.1:5454"],
    mode: "Primary",
    remote_extensions: null,
    pgbouncer_settings: null,
    reconfigure_concurrency: 1,
    drop_subscriptions_before_start: false,
    audit_log_level: "Disabled",
    suspend_timeout_seconds: -1,
  };
  return JSON.stringify({ spec, compute_ctl_config: {} }, null, 2);
}
