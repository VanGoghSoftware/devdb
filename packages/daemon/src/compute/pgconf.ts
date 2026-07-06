// oracle: neon compute_tools/src/config.rs → write_postgres_conf (postgresql.conf assembly from
// the ComputeSpec). Deviations: no ssl block, no cert files.

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
    // CONFIRMED live (Task 14): unquoted "0.0.0.0" produced a real postgresql.conf parse
    // failure (`syntax error in file "...postgresql.conf" line 18, near token ".0"`) —
    // Postgres's GUC lexer tokenizes an unquoted value containing dots instead of treating it
    // as one string, exactly like log_line_prefix/hba_file below already need pgQuote().
    ["listen_addresses", pgQuote("0.0.0.0")], ["port", String(a.port)],
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

// oracle: neon compute_tools/src/spec.rs → update_pg_hba + params.rs::PG_HBA_ALL_MD5, hostssl
// lines dropped (no TLS). Deviation: neon appends one md5 catch-all onto initdb's own pg_hba.conf
// defaults; DevDB instead writes the whole file, with trust for cloud_admin on loopback.
// (deviation: oracle uses ::1/32, which is far broader than IPv6 loopback — /128 is the loopback host)
export const PG_HBA = `# TYPE  DATABASE  USER          ADDRESS       METHOD
local   all       cloud_admin                 trust
host    all       cloud_admin   127.0.0.1/32  trust
host    all       cloud_admin   ::1/128       trust
host    all       all           all           scram-sha-256
`;
