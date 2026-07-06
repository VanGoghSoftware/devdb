import { computePostgresqlConf } from "./pgconf.js";
import { scramSha256Verifier } from "./scram.js";
import { assertEngineId } from "../engine/ids.js";

// oracle: neon libs/compute_api/src/spec.rs (ComputeSpec struct) + compute_tools/src/spec_apply.rs
// (how compute_ctl consumes it); DevDB emits the minimal spec compute_ctl requires to boot.
// Deviation: storage_auth_token omitted (trust mode).
// CONFIRMED live (Task 14): the pageserver_connection_info shards key ("0000") encoding below
// was accepted as-is by compute_ctl on the first live launch that got far enough to attach to
// the pageserver — the branching isolation integration test (parent data visible pre-fork,
// both-direction write isolation) passed against it unchanged. No shards-key fix was needed;
// the legacy pageserver_connstring fallback also present below was not required either.
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
  // CONFIRMED live (Task 14): compute_ctl's ComputeCtlConfig deserializer requires the `jwks`
  // key to be present — first observed error: `missing field \`jwks\` at line 61 column 26`
  // when this object was `{}`. Setting `jwks: []` (a bare array) then produced:
  // `invalid length 0, expected struct JwkSet with 1 element at line 62 column 14` — that error
  // is serde's derived message for a *struct* being fed a JSON array instead of a JSON object
  // (it counts JwkSet's one named field, `keys`, positionally). `jwks` is therefore a single
  // `jsonwebtoken::jwk::JwkSet { keys: Vec<Jwk> }` object (binary strings confirm the
  // `jsonwebtoken` crate + `JwkSet`/`keys` identifiers), not an array of JwkSets — `{ keys: [] }`
  // is the JSON-level "no JWKS sources configured" (devdb has no local_proxy JWT auth in Phase 1).
  const computeCtlConfig = { jwks: { keys: [] } };
  return JSON.stringify({ spec, compute_ctl_config: computeCtlConfig }, null, 2);
}
