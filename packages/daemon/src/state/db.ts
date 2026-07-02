import Database from "better-sqlite3";
import { DDL } from "./schema.js";
import { BranchesRepo, ProjectsRepo, SettingsRepo } from "./repos.js";

export interface StateDb {
  raw: Database.Database;
  projects: ProjectsRepo;
  branches: BranchesRepo;
  settings: SettingsRepo;
}

export function openState(path: string): StateDb {
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(DDL);
  return {
    raw,
    projects: new ProjectsRepo(raw),
    branches: new BranchesRepo(raw),
    settings: new SettingsRepo(raw),
  };
}
