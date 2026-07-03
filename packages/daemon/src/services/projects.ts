import { DEFAULT_PG_VERSION, type PgVersion } from "@devdb/shared";
import type { StateDb } from "../state/db.js";
import type { BranchRow, ProjectRow } from "../state/repos.js";
import type { ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "./engine-api.js";
import type { LogsService } from "./logs.js";
import { newHexId } from "../engine/ids.js";
import { generatePassword } from "../compute/scram.js";
import { DevdbError } from "./errors.js";
import { slugify } from "./slug.js";

// Amendment A2 (controller): deps are typed against the narrow structural interfaces in
// engine-api.ts (containing exactly the methods this service calls), not the concrete engine
// client / ComputeManager classes. Production wiring passes the real classes (they satisfy
// these interfaces structurally); unit tests pass plainly-typed fakes — no `as never` casts.
export interface ProjectsDeps {
  state: StateDb;
  storcon: StorconApi;
  pageserver: PageserverApi;
  safekeeper: SafekeeperApi;
  computes: ComputesApi;
}

// oracle: tenant config values src/mgmt/service/project.rs:95-108
export const TENANT_CONFIG = {
  gc_period: "1h",
  gc_horizon: 67108864,
  pitr_interval: "7 days",
  checkpoint_distance: 268435456,
  checkpoint_timeout: "5m",
};

export class ProjectsService {
  // Fix 3 (review): `logs` is an OPTIONAL extra dep, not added to the shared ProjectsDeps
  // interface — ProjectsDeps is also the base type BranchesService/EndpointsService extend for
  // their OWN deps, and this eviction concern is specific to ProjectsService's delete() leaves
  // loop (mirrors BranchesService's own optional `logs?: LogsService`, same rationale: plenty of
  // existing tests construct this service without a LogsService, and evict() here is cleanup, not
  // something delete()'s correctness depends on).
  constructor(private deps: ProjectsDeps & { logs?: LogsService }) {}

  async create(a: { name: string; pgVersion?: PgVersion }): Promise<{ project: ProjectRow; mainBranch: BranchRow }> {
    const name = a.name.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}$/.test(name)) {
      throw new DevdbError(400, `invalid project name: ${JSON.stringify(a.name)}`);
    }
    if (this.deps.state.projects.byName(name)) {
      throw new DevdbError(409, `project "${name}" already exists`);
    }
    const pgVersion = a.pgVersion ?? DEFAULT_PG_VERSION;
    const projectId = newHexId(); // doubles as tenant id — oracle: project.rs:83-84

    await this.deps.storcon.tenantCreate(projectId, TENANT_CONFIG);
    try {
      // oracle: bootstrap mode timeline create — src/mgmt/service/branch.rs:124-128
      const timelineId = newHexId();
      await this.deps.pageserver.timelineCreate(projectId, {
        new_timeline_id: timelineId,
        pg_version: pgVersion,
      });

      const password = generatePassword();
      // suffixed like branch slugs elsewhere — collision-proof even if two projects normalize
      // to the same base slug (name uniqueness is enforced separately by the byName check above).
      const slug = `${slugify(name, "main")}-${timelineId.slice(0, 6)}`;
      const branchId = crypto.randomUUID();
      // the two local inserts are atomic — never leave a project row without its main branch.
      const tx = this.deps.state.raw.transaction(() => {
        this.deps.state.projects.create({ id: projectId, name, pgVersion });
        this.deps.state.branches.create({
          id: branchId,
          projectId,
          parentBranchId: null,
          name: "main",
          slug,
          timelineId,
          password,
          createdBy: "api",
        });
      });
      try {
        tx();
      } catch (e) {
        if ((e as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT")) {
          throw new DevdbError(409, `project or branch identity conflicts with an existing one: ${(e as Error).message}`);
        }
        throw e;
      }
      return {
        project: this.deps.state.projects.byId(projectId)!,
        mainBranch: this.deps.state.branches.byId(branchId)!,
      };
    } catch (e) {
      // compensation: never leave a live tenant on the engine for a create that failed after
      // tenantCreate succeeded (best-effort — loud on failure rather than silently swallowed).
      await this.deps.pageserver.tenantDelete(projectId).catch((c) =>
        console.error(`compensation failed — orphaned tenant ${projectId} on pageserver:`, c));
      await this.deps.safekeeper.tenantDelete(projectId).catch((c) =>
        console.error(`compensation failed — orphaned tenant ${projectId} on safekeeper:`, c));
      throw e;
    }
  }

  list(): ProjectRow[] {
    return this.deps.state.projects.list();
  }

  byIdOr404(id: string): ProjectRow {
    const p = this.deps.state.projects.byId(id);
    if (!p) throw new DevdbError(404, `project ${id} not found`);
    return p;
  }

  async delete(id: string): Promise<void> {
    const project = this.byIdOr404(id);
    const branches = this.deps.state.branches.listByProject(project.id);
    // children before parents: repeatedly remove leaves
    const remaining = new Map(branches.map((b) => [b.id, b]));
    while (remaining.size > 0) {
      const leaves = [...remaining.values()].filter(
        (b) => ![...remaining.values()].some((o) => o.parentBranchId === b.id),
      );
      if (leaves.length === 0) {
        throw new DevdbError(500, "branch tree has a cycle or dangling parent — aborting project delete");
      }
      for (const leaf of leaves) {
        await this.deps.computes.stop(leaf.id);
        await this.deps.pageserver.timelineDelete(project.id, leaf.timelineId);
        await this.deps.safekeeper.timelineDelete(project.id, leaf.timelineId);
        this.deps.state.branches.delete(leaf.id);
        // Fix 3 (review): same rationale as BranchesService.delete()'s own evict() call — this
        // leaf's branch id is gone for good, so its `branch:<id>:compute` channel (ring + subs)
        // should go with it rather than accumulating in LogsService for the life of the daemon.
        this.deps.logs?.evict(`branch:${leaf.id}:compute`);
        remaining.delete(leaf.id);
      }
    }
    // oracle: src/mgmt/service/project.rs:351-395
    await this.deps.pageserver.tenantDelete(project.id);
    await this.deps.safekeeper.tenantDelete(project.id);
    this.deps.state.projects.delete(project.id);
  }
}
