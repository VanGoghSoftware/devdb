import type Database from "better-sqlite3";
import type { BranchContext, PgBuildStatus, PgVersion } from "@devdb/shared";

export interface ProjectRow {
  id: string; name: string; pgVersion: PgVersion; createdAt: string; updatedAt: string;
}
export interface BranchRow {
  id: string; projectId: string; parentBranchId: string | null; name: string; slug: string;
  timelineId: string; password: string; stickyPort: number | null; endpointStatus: string;
  endpointError: string | null;
  importStatus: string; importError: string | null; createdBy: "ui" | "api" | "mcp";
  context: BranchContext | null;
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
    endpointStatus: r.endpoint_status as string,
    endpointError: (r.endpoint_error as string | null) ?? null,
    importStatus: r.import_status as string,
    importError: (r.import_error as string | null) ?? null,
    // Row boundary: created_by is constrained by every write path (services pass the literal union;
    // there is no other writer), so this is the one place the string column narrows to the union —
    // letting dto.ts and everything downstream drop their per-use casts (handover §9 close-out).
    createdBy: r.created_by as BranchRow["createdBy"],
    context: r.context ? (JSON.parse(r.context as string) as BranchContext) : null,
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
    timelineId: string; password: string; createdBy: BranchRow["createdBy"]; context?: BranchContext | null;
  }): BranchRow {
    this.db.prepare(
      `INSERT INTO branches (id, project_id, parent_branch_id, name, slug, timeline_id, password, created_by, context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, a.projectId, a.parentBranchId, a.name, a.slug, a.timelineId, a.password, a.createdBy,
      a.context ? JSON.stringify(a.context) : null);
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
  // a.error is durable, not incremental: pass the failure message on a "failed" transition,
  // omit it (or pass null explicitly) on every other transition to clear a stale error.
  updateEndpoint(id: string, a: { status: string; port: number | null; error?: string | null }): void {
    this.db.prepare(
      "UPDATE branches SET endpoint_status = ?, sticky_port = COALESCE(?, sticky_port), endpoint_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    ).run(a.status, a.port, a.error ?? null, id);
  }
  setStickyPort(id: string, port: number): void {
    this.db.prepare("UPDATE branches SET sticky_port = ? WHERE id = ?").run(port, id);
  }
  // Phase 3 Task 4: rename mutates NAME only — `slug` is untouched (it feeds compute naming and
  // directories; a rename must never touch engine artifacts). Same strftime idiom as updateEndpoint.
  updateName(id: string, name: string): void {
    this.db.prepare(
      "UPDATE branches SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    ).run(name, id);
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
        `INSERT INTO branches (id, project_id, parent_branch_id, name, slug, timeline_id, password, sticky_port, created_by, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(a.newBranchId, old.projectId, old.parentBranchId, old.name, old.slug,
        a.newTimelineId, old.password, old.stickyPort, old.createdBy,
        old.context ? JSON.stringify(old.context) : null);
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

export interface PgBuildRow {
  id: string; major: number; minor: number | null; source: "baked" | "downloaded";
  releaseTag: string; imageDigest: string; path: string; status: PgBuildStatus;
  active: boolean; sizeBytes: number | null; error: string | null; createdAt: string;
}

function pgBuildRow(r: Record<string, unknown>): PgBuildRow {
  return {
    id: r.id as string, major: r.major as number, minor: (r.minor as number | null) ?? null,
    // Row boundary: source/status are constrained by every write path in this file (the only
    // writers), same narrowing rationale as branchRow's createdBy above.
    source: r.source as PgBuildRow["source"], releaseTag: r.release_tag as string,
    imageDigest: r.image_digest as string, path: r.path as string,
    status: r.status as PgBuildStatus, active: (r.active as number) === 1,
    sizeBytes: (r.size_bytes as number | null) ?? null, error: (r.error as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export class PgBuildsRepo {
  constructor(private db: Database.Database) {}
  insert(a: {
    id: string; major: number; source: "baked" | "downloaded"; releaseTag: string;
    imageDigest: string; path: string; status: PgBuildStatus; minor?: number | null; sizeBytes?: number | null;
  }): PgBuildRow {
    this.db.prepare(
      `INSERT INTO pg_builds (id, major, minor, source, release_tag, image_digest, path, status, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, a.major, a.minor ?? null, a.source, a.releaseTag, a.imageDigest, a.path, a.status, a.sizeBytes ?? null);
    return this.byId(a.id)!;
  }
  byId(id: string): PgBuildRow | null {
    const r = this.db.prepare("SELECT * FROM pg_builds WHERE id = ?").get(id);
    return r ? pgBuildRow(r as Record<string, unknown>) : null;
  }
  // Multiple rows may legitimately share a digest (e.g. a gate-failed attempt followed by a
  // successful retry) — prefer a ready row, then the newest, so the dedup check ("is this digest
  // already installed?") never lands on a stale failed attempt when a usable install exists.
  byDigest(digest: string): PgBuildRow | null {
    const r = this.db.prepare(
      `SELECT * FROM pg_builds WHERE image_digest = ? AND image_digest != ''
       ORDER BY (status = 'ready') DESC, created_at DESC, rowid DESC LIMIT 1`,
    ).get(digest);
    return r ? pgBuildRow(r as Record<string, unknown>) : null;
  }
  byMajorAndTag(major: number, tag: string): PgBuildRow | null {
    const r = this.db.prepare("SELECT * FROM pg_builds WHERE major = ? AND release_tag = ?").get(major, tag);
    return r ? pgBuildRow(r as Record<string, unknown>) : null;
  }
  list(): PgBuildRow[] {
    return this.db.prepare("SELECT * FROM pg_builds ORDER BY major, created_at").all()
      .map((r) => pgBuildRow(r as Record<string, unknown>));
  }
  listByMajor(major: number): PgBuildRow[] {
    return this.db.prepare("SELECT * FROM pg_builds WHERE major = ? ORDER BY created_at").all(major)
      .map((r) => pgBuildRow(r as Record<string, unknown>));
  }
  setStatus(id: string, status: PgBuildStatus, error?: string | null): void {
    this.db.prepare("UPDATE pg_builds SET status = ?, error = ? WHERE id = ?").run(status, error ?? null, id);
  }
  setDetected(id: string, a: { minor: number; sizeBytes: number | null }): void {
    this.db.prepare("UPDATE pg_builds SET minor = ?, size_bytes = ? WHERE id = ?").run(a.minor, a.sizeBytes, id);
  }
  // Minor-only update — FIX-2's baked re-probe (seedBaked): an image upgrade on the persisted
  // volume changes a baked dir's binary in place, so its row minor must follow the re-detected
  // truth (raise OR lower — the downgrade guard lives in pgMajors/activate, not in this column).
  updateMinor(id: string, minor: number): void {
    this.db.prepare("UPDATE pg_builds SET minor = ? WHERE id = ?").run(minor, id);
  }
  updatePath(id: string, path: string): void {
    this.db.prepare("UPDATE pg_builds SET path = ? WHERE id = ?").run(path, id);
  }
  // Fills in the digest + content-addressed path on an in-flight row once resolveDigest has run —
  // pull() inserts the row with the '' digest sentinel before either is known.
  setDigestPath(id: string, a: { imageDigest: string; path: string }): void {
    this.db.prepare("UPDATE pg_builds SET image_digest = ?, path = ? WHERE id = ?").run(a.imageDigest, a.path, id);
  }
  // Transactional: at most one active row per major, ever (spec: "one atomic flip within the major").
  setActiveExclusive(id: string): void {
    const tx = this.db.transaction(() => {
      const row = this.byId(id);
      if (!row) throw new Error(`pg_build ${id} not found`);
      this.db.prepare("UPDATE pg_builds SET active = 0 WHERE major = ?").run(row.major);
      this.db.prepare("UPDATE pg_builds SET active = 1 WHERE id = ?").run(id);
    });
    tx();
  }
  clearActive(major: number): void {
    this.db.prepare("UPDATE pg_builds SET active = 0 WHERE major = ?").run(major);
  }
  delete(id: string): void {
    this.db.prepare("DELETE FROM pg_builds WHERE id = ?").run(id);
  }
}

export class PgMajorsRepo {
  constructor(private db: Database.Database) {}
  lastRunMinor(major: number): number | null {
    const r = this.db.prepare("SELECT last_run_minor FROM pg_majors WHERE major = ?").get(major) as
      | { last_run_minor: number } | undefined;
    return r?.last_run_minor ?? null;
  }
  // Raise-only high-water mark: an endpoint START of version major.minor. Never lowers (the
  // downgrade guard compares against this; only setLastRunMinor — consented rollback — lowers).
  recordRun(major: number, minor: number): void {
    this.db.prepare(
      `INSERT INTO pg_majors (major, last_run_minor) VALUES (?, ?)
       ON CONFLICT(major) DO UPDATE SET last_run_minor = MAX(last_run_minor, excluded.last_run_minor)`,
    ).run(major, minor);
  }
  setLastRunMinor(major: number, minor: number): void {
    this.db.prepare(
      `INSERT INTO pg_majors (major, last_run_minor) VALUES (?, ?)
       ON CONFLICT(major) DO UPDATE SET last_run_minor = excluded.last_run_minor`,
    ).run(major, minor);
  }
}
