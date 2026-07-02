import Database from "better-sqlite3";
import { DDL } from "./schema.js";
import { BranchesRepo, ProjectsRepo, SettingsRepo } from "./repos.js";

export interface StateDb {
  raw: Database.Database;
  projects: ProjectsRepo;
  branches: BranchesRepo;
  settings: SettingsRepo;
}

// Additive schema evolution: CREATE TABLE IF NOT EXISTS never alters existing
// tables, and state.db outlives container upgrades. Add any column that the
// current schema declares but an older database lacks. Additive-only by design.
function applyAdditiveMigrations(raw: Database.Database): void {
  const REQUIRED_COLUMNS: Record<string, Record<string, string>> = {
    branches: { endpoint_error: "TEXT" },
  };
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const existing = new Set(
      (raw.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>)
        .map((c) => c.name),
    );
    for (const [column, type] of Object.entries(columns)) {
      if (!existing.has(column)) {
        raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
  }
}

export function openState(path: string): StateDb {
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(DDL);
  applyAdditiveMigrations(raw);
  return {
    raw,
    projects: new ProjectsRepo(raw),
    branches: new BranchesRepo(raw),
    settings: new SettingsRepo(raw),
  };
}
