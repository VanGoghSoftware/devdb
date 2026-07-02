import { DEFAULT_PG_VERSION, type PgVersion } from "@devdb/shared";
import type { StateDb } from "../state/db.js";
import type { BranchRow, ProjectRow } from "../state/repos.js";
import type { ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "./engine-api.js";
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
  constructor(private deps: ProjectsDeps) {}

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

    // oracle: bootstrap mode timeline create — src/mgmt/service/branch.rs:124-128
    const timelineId = newHexId();
    await this.deps.pageserver.timelineCreate(projectId, {
      new_timeline_id: timelineId,
      pg_version: pgVersion,
    });

    const project = this.deps.state.projects.create({ id: projectId, name, pgVersion });
    const mainBranch = this.deps.state.branches.create({
      id: crypto.randomUUID(),
      projectId,
      parentBranchId: null,
      name: "main",
      slug: slugify(name, "main"),
      timelineId,
      password: generatePassword(),
      createdBy: "api",
    });
    return { project, mainBranch };
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
      for (const leaf of leaves) {
        await this.deps.computes.stop(leaf.id);
        await this.deps.pageserver.timelineDelete(project.id, leaf.timelineId);
        await this.deps.safekeeper.timelineDelete(project.id, leaf.timelineId);
        this.deps.state.branches.delete(leaf.id);
        remaining.delete(leaf.id);
      }
    }
    // oracle: src/mgmt/service/project.rs:351-395
    await this.deps.pageserver.tenantDelete(project.id);
    await this.deps.safekeeper.tenantDelete(project.id);
    this.deps.state.projects.delete(project.id);
  }
}
