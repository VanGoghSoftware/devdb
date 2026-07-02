import type Database from "better-sqlite3";
import type { PgVersion } from "@devdb/shared";

export interface ProjectRow {
  id: string; name: string; pgVersion: PgVersion; createdAt: string; updatedAt: string;
}
export interface BranchRow {
  id: string; projectId: string; parentBranchId: string | null; name: string; slug: string;
  timelineId: string; password: string; stickyPort: number | null; endpointStatus: string;
  importStatus: string; importError: string | null; createdBy: string;
  createdAt: string; updatedAt: string;
}

function projectRow(r: Record<string, unknown>): ProjectRow {
  return {
    id: r.id as string, name: r.name as string, pgVersion: r.pg_version as PgVersion,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}
function branchRow(r: Record<string, unknown>): BranchRow {
  return {
    id: r.id as string, projectId: r.project_id as string,
    parentBranchId: (r.parent_branch_id as string | null) ?? null,
    name: r.name as string, slug: r.slug as string, timelineId: r.timeline_id as string,
    password: r.password as string, stickyPort: (r.sticky_port as number | null) ?? null,
    endpointStatus: r.endpoint_status as string, importStatus: r.import_status as string,
    importError: (r.import_error as string | null) ?? null, createdBy: r.created_by as string,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}

export class ProjectsRepo {
  constructor(private db: Database.Database) {}
  create(a: { id: string; name: string; pgVersion: PgVersion }): ProjectRow {
    this.db.prepare("INSERT INTO projects (id, name, pg_version) VALUES (?, ?, ?)")
      .run(a.id, a.name, a.pgVersion);
    return this.byId(a.id)!;
  }
  list(): ProjectRow[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY created_at").all()
      .map((r) => projectRow(r as Record<string, unknown>));
  }
  byId(id: string): ProjectRow | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return r ? projectRow(r as Record<string, unknown>) : null;
  }
  byName(name: string): ProjectRow | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE name = ?").get(name);
    return r ? projectRow(r as Record<string, unknown>) : null;
  }
  // Throws SQLITE_CONSTRAINT (FOREIGN KEY) if referencing rows exist — services guard ordering (children first).
  delete(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
}

export class BranchesRepo {
  constructor(private db: Database.Database) {}
  create(a: {
    id: string; projectId: string; parentBranchId: string | null; name: string; slug: string;
    timelineId: string; password: string; createdBy: string;
  }): BranchRow {
    this.db.prepare(
      `INSERT INTO branches (id, project_id, parent_branch_id, name, slug, timeline_id, password, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, a.projectId, a.parentBranchId, a.name, a.slug, a.timelineId, a.password, a.createdBy);
    return this.byId(a.id)!;
  }
  byId(id: string): BranchRow | null {
    const r = this.db.prepare("SELECT * FROM branches WHERE id = ?").get(id);
    return r ? branchRow(r as Record<string, unknown>) : null;
  }
  byProjectAndName(projectId: string, name: string): BranchRow | null {
    const r = this.db.prepare("SELECT * FROM branches WHERE project_id = ? AND name = ?")
      .get(projectId, name);
    return r ? branchRow(r as Record<string, unknown>) : null;
  }
  listByProject(projectId: string): BranchRow[] {
    return this.db.prepare("SELECT * FROM branches WHERE project_id = ? ORDER BY created_at")
      .all(projectId).map((r) => branchRow(r as Record<string, unknown>));
  }
  listByParent(parentBranchId: string): BranchRow[] {
    return this.db.prepare("SELECT * FROM branches WHERE parent_branch_id = ?")
      .all(parentBranchId).map((r) => branchRow(r as Record<string, unknown>));
  }
  updateEndpoint(id: string, a: { status: string; port: number | null }): void {
    this.db.prepare(
      "UPDATE branches SET endpoint_status = ?, sticky_port = COALESCE(?, sticky_port), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    ).run(a.status, a.port, id);
  }
  setStickyPort(id: string, port: number): void {
    this.db.prepare("UPDATE branches SET sticky_port = ? WHERE id = ?").run(port, id);
  }
  // Throws SQLITE_CONSTRAINT (FOREIGN KEY) if referencing rows exist — services guard ordering (children first).
  delete(id: string): void {
    this.db.prepare("DELETE FROM branches WHERE id = ?").run(id);
  }
  countAll(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM branches").get() as { n: number };
    return r.n;
  }
  // oracle: src/mgmt/repository/branch.rs:251 restore_swap — archive old row under new
  // name/slug, insert replacement carrying the original identity (name/slug/password/port),
  // reparent children whose timelines the engine reparented, repoint remaining children.
  restoreSwap(a: {
    oldBranchId: string; newBranchId: string; newTimelineId: string;
    archiveName: string; archiveSlug: string; reparentedTimelineIds: string[];
  }): BranchRow {
    const tx = this.db.transaction(() => {
      const old = this.byId(a.oldBranchId);
      if (!old) throw new Error(`branch ${a.oldBranchId} not found`);
      this.db.prepare("UPDATE branches SET name = ?, slug = ?, sticky_port = NULL WHERE id = ?")
        .run(a.archiveName, a.archiveSlug, a.oldBranchId);
      this.db.prepare(
        `INSERT INTO branches (id, project_id, parent_branch_id, name, slug, timeline_id, password, sticky_port, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(a.newBranchId, old.projectId, old.parentBranchId, old.name, old.slug,
        a.newTimelineId, old.password, old.stickyPort, old.createdBy);
      if (a.reparentedTimelineIds.length > 0) {
        const placeholders = a.reparentedTimelineIds.map(() => "?").join(",");
        this.db.prepare(
          `UPDATE branches SET parent_branch_id = ? WHERE project_id = ? AND timeline_id IN (${placeholders})`,
        ).run(a.newBranchId, old.projectId, ...a.reparentedTimelineIds);
      }
      this.db.prepare("UPDATE branches SET parent_branch_id = ? WHERE parent_branch_id = ? AND id != ?")
        .run(a.newBranchId, a.oldBranchId, a.newBranchId);
    });
    tx();
    return this.byId(a.newBranchId)!;
  }
}

export class SettingsRepo {
  constructor(private db: Database.Database) {}
  get(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string } | undefined;
    return r?.value ?? null;
  }
  set(key: string, value: string): void {
    this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }
}
