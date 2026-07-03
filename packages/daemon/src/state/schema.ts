export const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  pg_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_branch_id TEXT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  timeline_id TEXT NOT NULL,
  password TEXT NOT NULL,
  sticky_port INTEGER,
  endpoint_status TEXT NOT NULL DEFAULT 'stopped',
  endpoint_error TEXT,
  import_status TEXT NOT NULL DEFAULT 'none',
  import_error TEXT,
  context TEXT,
  created_by TEXT NOT NULL DEFAULT 'api',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(project_id, name),
  UNIQUE(project_id, id),
  FOREIGN KEY (project_id, parent_branch_id) REFERENCES branches(project_id, id)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  branch_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  log_path TEXT,
  lsn TEXT,
  size_bytes INTEGER,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS export_targets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  config TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
