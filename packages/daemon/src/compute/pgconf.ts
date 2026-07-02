// oracle: src/mgmt/compute/mod.rs:737-809 setup_pg_conf. Deviations: no ssl block, no cert files.

function pgQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function computePostgresqlConf(a: { port: number; hbaPath: string }): string {
  const kv: Array<[string, string]> = [
    ["max_wal_senders", "10"], ["wal_log_hints", "off"], ["max_replication_slots", "10"],
    ["hot_standby", "on"],
    ["shared_buffers", "128MB"], ["effective_cache_size", "512MB"], ["work_mem", "8MB"],
    ["maintenance_work_mem", "128MB"], ["max_connections", "100"],
    ["effective_io_concurrency", "100"], ["random_page_cost", "1.1"],
    ["fsync", "off"], ["synchronous_commit", "on"],
    ["wal_level", "logical"], ["wal_sender_timeout", "60s"], ["wal_keep_size", "0"],
    ["restart_after_crash", "off"],
    ["listen_addresses", "0.0.0.0"], ["port", String(a.port)],
    ["shared_preload_libraries", "neon"],
    ["jit", "off"],
    ["statement_timeout", "0"], ["idle_in_transaction_session_timeout", "600000"],
    ["autovacuum_max_workers", "4"], ["autovacuum_naptime", "10s"],
    ["autovacuum_vacuum_scale_factor", "0.05"], ["autovacuum_analyze_scale_factor", "0.02"],
    ["autovacuum_vacuum_cost_limit", "2000"],
    ["log_min_duration_statement", "1000"], ["log_connections", "on"],
    ["log_disconnections", "on"], ["log_checkpoints", "on"], ["log_lock_waits", "on"],
    ["log_temp_files", "0"], ["log_autovacuum_min_duration", "1000"],
    ["log_line_prefix", "'%m [%p] %q%u@%d '"],
    ["max_replication_write_lag", "500MB"], ["max_replication_flush_lag", "10GB"],
    ["synchronous_standby_names", "walproposer"],
    ["neon.safekeepers", "localhost:5454"],
    ["password_encryption", "scram-sha-256"],
    ["hba_file", pgQuote(a.hbaPath)],
  ];
  return kv.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

// oracle: src/mgmt/compute/pg_hba.conf, hostssl lines dropped (no TLS)
// (deviation: oracle uses ::1/32, which is far broader than IPv6 loopback — /128 is the loopback host)
export const PG_HBA = `# TYPE  DATABASE  USER          ADDRESS       METHOD
local   all       cloud_admin                 trust
host    all       cloud_admin   127.0.0.1/32  trust
host    all       cloud_admin   ::1/128       trust
host    all       all           all           scram-sha-256
`;
