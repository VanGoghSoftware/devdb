import type { BranchContext, EndpointStatus } from "@devdb/shared";
import type { BranchRow } from "../state/repos.js";
import type { BranchQueue } from "../state/queue.js";
import { newHexId } from "../engine/ids.js";
import { generatePassword } from "../compute/scram.js";
import { EngineApiError } from "../engine/http.js";
import { DevdbError } from "./errors.js";
import { slugify } from "./slug.js";
import type { ProjectsDeps } from "./projects.js";
import type { LogsService } from "./logs.js";

export type BranchDetail = BranchRow & {
  endpointStatus: EndpointStatus;
  endpointError: string | null;
  port: number | null;
  connectionString: string | null;
  lastRecordLsn: string | null;
  logicalSizeBytes: number | null;
  ancestorLsn: string | null;
};

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 /._-]{0,62}$/;

export class BranchesService {
  // Fix 3 (review): `logs` is OPTIONAL — unlike EndpointsService's required `logs` dep, plenty of
  // existing unit tests construct BranchesService directly without a LogsService in hand (it has
  // nothing to do with the compute-startup log wiring Fix 1 touches), and evict() on delete is a
  // cleanup nicety, not something delete()'s correctness depends on. Optional-chained at the one
  // call site below rather than forcing every existing test/caller to thread a real or fake
  // LogsService through just for this.
  constructor(private deps: ProjectsDeps & { queue: BranchQueue; logs?: LogsService }) {}

  byIdOr404(id: string): BranchRow {
    const b = this.deps.state.branches.byId(id);
    if (!b) throw new DevdbError(404, `branch ${id} not found`);
    return b;
  }

  // MCP tools take branch by NAME, scoped to an already-resolved project — same rationale as
  // ProjectsService.byNameOr404: one place phrases the actionable "call list_branches" remediation
  // for every read tool that resolves a branch by name.
  byProjectAndNameOr404(projectId: string, name: string): BranchRow {
    const b = this.deps.state.branches.byProjectAndName(projectId, name.trim());
    if (!b) throw new DevdbError(404, `branch "${name}" not found in this project — call list_branches`);
    return b;
  }

  // Amendment A11 (controller): percent-encode the password via encodeURIComponent — passwords
  // are alphanumeric today (compute/scram.ts CHARSET) so this is a no-op in practice, but it
  // keeps the connection-string contract safe if that charset ever grows URL-special characters.
  // oracle: src/mgmt/model/branch.rs get_connection_string; no sslmode (no TLS in devdb)
  connectionString(branch: BranchRow, port: number): string {
    return `postgresql://postgres:${encodeURIComponent(branch.password)}@localhost:${port}/postgres`;
  }

  // oracle: src/mgmt/service/branch.rs:66-208 create()
  async create(a: {
    projectId: string; name: string; parentBranchId?: string | null;
    atLsn?: string | null; createdBy?: "ui" | "api" | "mcp"; context?: BranchContext | null;
  }): Promise<BranchRow> {
    const name = a.name.trim();
    const project = this.deps.state.projects.byId(a.projectId);
    if (!project) throw new DevdbError(404, `project ${a.projectId} not found`);
    if (!NAME_RE.test(name)) throw new DevdbError(400, `invalid branch name: ${JSON.stringify(a.name)}`);
    if (this.deps.state.branches.byProjectAndName(project.id, name)) {
      throw new DevdbError(409, `branch "${name}" already exists in project "${project.name}"`);
    }

    let parent: BranchRow | null;
    if (a.parentBranchId === undefined) {
      parent = this.deps.state.branches.byProjectAndName(project.id, "main");
      if (!parent) throw new DevdbError(500, `project "${project.name}" has no main branch`);
    } else if (a.parentBranchId === null) {
      throw new DevdbError(400, "parentBranchId cannot be null — root branches only exist via project create");
    } else {
      parent = this.byIdOr404(a.parentBranchId);
      if (parent.projectId !== project.id) throw new DevdbError(400, "parent branch belongs to a different project");
    }

    // Serialized under the PARENT's queue key — not a new key of our own — so that a concurrent
    // delete() of this same parent (which queues under branch.id, i.e. the parent's id) can never
    // race a create() underneath it: both operations now share one queue lane keyed by parent.id.
    return this.deps.queue.run(parent.id, async () => {
      // re-check inside the queue: parent may have been deleted while we waited in line
      if (!this.deps.state.branches.byId(parent.id)) {
        throw new DevdbError(409, `parent branch "${parent.name}" was deleted while creating "${name}"`);
      }
      if (this.deps.state.branches.byProjectAndName(project.id, name)) {
        throw new DevdbError(409, `branch "${name}" already exists in project "${project.name}"`);
      }
      const timelineId = newHexId();
      const req: { new_timeline_id: string } & Record<string, unknown> = {
        new_timeline_id: timelineId,
        ancestor_timeline_id: parent.timelineId,
        read_only: false,
      };
      if (a.atLsn) req.ancestor_start_lsn = a.atLsn;
      await this.deps.pageserver.timelineCreate(project.id, req);

      try {
        return this.deps.state.branches.create({
          id: crypto.randomUUID(),
          projectId: project.id,
          parentBranchId: parent.id,
          name,
          slug: `${slugify(project.name, name)}-${timelineId.slice(0, 6)}`,
          timelineId,
          password: generatePassword(),
          createdBy: a.createdBy ?? "api",
          context: a.context ?? null,
        });
      } catch (e) {
        // compensation: never leave a live timeline on the engine for a create that failed after
        // timelineCreate succeeded (best-effort — loud on failure rather than silently swallowed).
        await this.deps.pageserver.timelineDelete(project.id, timelineId).catch((c) =>
          this.deps.logger.error(`compensation failed — orphaned timeline ${timelineId} on pageserver`, c));
        await this.deps.safekeeper.timelineDelete(project.id, timelineId).catch((c) =>
          this.deps.logger.error(`compensation failed — orphaned timeline ${timelineId} on safekeeper`, c));
        if ((e as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT")) {
          throw new DevdbError(409, `branch identity conflicts with an existing one`);
        }
        throw e;
      }
    });
  }

  async detail(branch: BranchRow): Promise<BranchDetail> {
    const status = this.deps.computes.statusOf(branch.id);
    const port = this.deps.computes.portOf(branch.id);
    let lastRecordLsn: string | null = null;
    let logicalSizeBytes: number | null = null;
    let ancestorLsn: string | null = null;
    try {
      const info = await this.deps.pageserver.timelineInfo(branch.projectId, branch.timelineId);
      lastRecordLsn = info.last_record_lsn ?? null;
      logicalSizeBytes = info.current_logical_size ?? null;
      ancestorLsn = info.ancestor_lsn ?? null;
    } catch (e) {
      if (!(e instanceof EngineApiError)) throw e; // programming bugs must surface
      // timeline info is enrichment — a briefly unavailable pageserver must not 500 branch listings
      console.error(`timeline enrichment unavailable for branch ${branch.id} (${branch.name}):`, e.message);
    }
    return {
      ...branch,
      endpointStatus: status,
      endpointError: branch.endpointError,
      port,
      connectionString: status === "running" && port ? this.connectionString(branch, port) : null,
      lastRecordLsn,
      logicalSizeBytes,
      ancestorLsn,
    };
  }

  async list(projectId: string): Promise<BranchDetail[]> {
    const rows = this.deps.state.branches.listByProject(projectId);
    return Promise.all(rows.map((b) => this.detail(b)));
  }

  // oracle: src/mgmt/service/branch.rs:416-519 delete()
  async delete(id: string): Promise<void> {
    return this.deps.queue.run(id, async () => {
      const branch = this.byIdOr404(id);
      const children = this.deps.state.branches.listByParent(branch.id);
      if (children.length > 0) {
        throw new DevdbError(409,
          `branch "${branch.name}" has child branches: ${children.map((c) => c.name).join(", ")} — delete them first`);
      }
      await this.deps.computes.stop(branch.id);
      await this.deps.pageserver.timelineDelete(branch.projectId, branch.timelineId);
      await this.deps.safekeeper.timelineDelete(branch.projectId, branch.timelineId);
      this.deps.state.branches.delete(branch.id);
      // Fix 3 (review): this branch id is gone for good (never reused) — its
      // `branch:<id>:compute` channel will never be ingested to or subscribed to again, so drop
      // both the ring buffer and any subscriber Set for it now rather than letting LogsService
      // hold onto them forever.
      this.deps.logs?.evict(`branch:${branch.id}:compute`);
    });
  }
}
