import { DEFAULT_PG_VERSION, type PgVersion } from "@devdb/shared";
import type { StateDb } from "../state/db.js";
import type { BranchRow, ProjectRow } from "../state/repos.js";
import type { ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "./engine-api.js";
import type { LogsService } from "./logs.js";
import type { EventsService } from "./events.js";
import type { Logger } from "../logging/logger.js";
import type { BranchQueue } from "../state/queue.js";
import { newHexId } from "../engine/ids.js";
import { generatePassword } from "../compute/scram.js";
import { DevdbError } from "./errors.js";
import { slugify } from "./slug.js";

// Amendment A2 (controller): deps are typed against the narrow structural interfaces in
// engine-api.ts (containing exactly the methods this service calls), not the concrete engine
// client / ComputeManager classes. Production wiring passes the real classes (they satisfy
// these interfaces structurally); unit tests pass plainly-typed fakes — no `as never` casts.
//
// Fix 1 (review): `queue` joins the lane model every other cross-branch mutation already uses
// (BranchesService.create/delete, EndpointsService.start/stop all serialize per branchId through
// this SAME BranchQueue instance). Before this fix, ProjectsService.delete() tore down each leaf
// branch's compute/timelines completely OUTSIDE that lane — so a concurrent
// endpoint.start(leafId) or branches.create() under that leaf could interleave with delete()'s own
// stop()/timelineDelete()/branches.delete() sequence with no ordering guarantee at all. Delete()
// now runs each leaf's teardown via `queue.run(leaf.id, ...)`, joining the same serialization
// point as every other operation on that branch id.
export interface ProjectsDeps {
  state: StateDb;
  storcon: StorconApi;
  pageserver: PageserverApi;
  safekeeper: SafekeeperApi;
  computes: ComputesApi;
  queue: BranchQueue;
  logger: Logger;
  // Task 2 (phase 3): OPTIONAL, on the SHARED base type (not bolted on per-service like `logs?`
  // is) — every other service types its own deps as `ProjectsDeps & {...}`, so BranchesService /
  // EndpointsService / TimeTravelService all inherit `events?` here with no further deps-type
  // edits. Optional so the many existing unit tests that construct services directly without an
  // EventsService keep typechecking unchanged.
  events?: EventsService;
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
    // Fix 5 (task-9 fix wave): both DevdbError messages now NAME A REMEDIATION, not just the
    // failure reason — improved here at the service layer (not just in the MCP tool) so
    // REST (POST /api/projects) benefits identically, per this fix's stated preference. A bare
    // "invalid project name"/"already exists" tells a caller WHAT happened but not what to do
    // about it; an agent especially can't self-correct from the reason alone.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}$/.test(name)) {
      throw new DevdbError(400,
        `invalid project name: ${JSON.stringify(a.name)} — names must start with a letter or digit and contain only letters, digits, spaces, underscores, or hyphens (max 63 characters)`);
    }
    if (this.deps.state.projects.byName(name)) {
      throw new DevdbError(409,
        `project "${name}" already exists — choose a different name, or use the existing project (call list_projects to see it)`);
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
          throw new DevdbError(409, `project or branch identity conflicts with an existing one`);
        }
        throw e;
      }
      // Emission map (spec Decision 1): ONE project.created event — clients invalidate BOTH
      // projects and branches off it, so the seeded main branch does NOT also get its own
      // branch.created (that would be redundant with what this single event already covers).
      this.deps.events?.publish({ type: "project.created", projectId });
      return {
        project: this.deps.state.projects.byId(projectId)!,
        mainBranch: this.deps.state.branches.byId(branchId)!,
      };
    } catch (e) {
      // compensation: never leave a live tenant on the engine for a create that failed after
      // tenantCreate succeeded (best-effort — loud on failure rather than silently swallowed).
      await this.deps.pageserver.tenantDelete(projectId).catch((c) =>
        this.deps.logger.error(`compensation failed — orphaned tenant ${projectId} on pageserver`, c));
      await this.deps.safekeeper.tenantDelete(projectId).catch((c) =>
        this.deps.logger.error(`compensation failed — orphaned tenant ${projectId} on safekeeper`, c));
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

  // MCP tools take project by NAME (agents don't know ids) — this resolver is the one place that
  // 404 remediation is phrased, so every read tool that resolves a project by name gets the same
  // actionable "call list_projects" next step rather than a bare not-found.
  byNameOr404(name: string): ProjectRow {
    const p = this.deps.state.projects.byName(name.trim());
    if (!p) throw new DevdbError(404, `project "${name}" not found — call list_projects to see available projects`);
    return p;
  }

  // One children-before-parents "sweep": compute a fresh leaves snapshot, tear each down (inside
  // its own queue lane), repeat until nothing remains for this project. Shared by delete()'s main
  // loop and its bounded final-sweep retry below so there is exactly one place that knows how to
  // safely drain a project's branches — no second, divergent copy of this logic to keep in sync.
  private async drainBranches(projectId: string): Promise<void> {
    while (true) {
      const remaining = this.deps.state.branches.listByProject(projectId);
      if (remaining.length === 0) return;
      const leaves = remaining.filter((b) => !remaining.some((o) => o.parentBranchId === b.id));
      if (leaves.length === 0) {
        throw new DevdbError(500, "branch tree has a cycle or dangling parent — aborting project delete");
      }
      for (const leaf of leaves) {
        await this.deps.queue.run(leaf.id, async () => {
          const b = this.deps.state.branches.byId(leaf.id);
          if (!b) return; // already torn down by a racing round/caller — nothing left to do
          // Re-check for children right here, inside the lane, mirroring
          // BranchesService.delete()'s own re-check at the top of its queued closure: `leaves`
          // was computed from a snapshot taken BEFORE this job reached the front of leaf.id's
          // queue, so a concurrent branches.create() parented under this exact leaf could have
          // landed in the interim (either before queue.run() was even called, or while this job
          // was waiting behind another job already occupying the lane). Deleting `b` now would
          // orphan that child's parent_branch_id / throw the FK constraint this whole restructure
          // exists to avoid — skip it for this round instead; the next fresh snapshot (next `while`
          // iteration) will pick both rows up again once the child is gone (or surface the child
          // itself as a leaf first).
          if (this.deps.state.branches.listByParent(b.id).length > 0) return;
          await this.deps.computes.stop(b.id);
          await this.deps.pageserver.timelineDelete(projectId, b.timelineId);
          await this.deps.safekeeper.timelineDelete(projectId, b.timelineId);
          this.deps.state.branches.delete(b.id);
          // Fix wave 1, Fix 3: symmetric with BranchesService.delete()'s own branch.deleted
          // publish — this leaf's row is being deleted directly against the repo (not via that
          // service), so without this it would never fire. Announced right after the delete
          // durably commits, so a client watching /api/events learns this branch is gone even if
          // the ENCLOSING project delete later fails (e.g. tenantDelete throws after the drain
          // completes) — the branch row really is gone at that point regardless of what happens
          // to the rest of the project teardown.
          this.deps.events?.publish({ type: "branch.deleted", projectId, branchId: b.id });
          // Fix 3 (review): same rationale as BranchesService.delete()'s own evict() call — this
          // leaf's branch id is gone for good, so its `branch:<id>:compute` channel (ring + subs)
          // should go with it rather than accumulating in LogsService for the life of the daemon.
          this.deps.logs?.evict(`branch:${b.id}:compute`);
        });
      }
    }
  }

  // Fix 1 (review): restructured around two things the previous one-shot-snapshot version got
  // wrong under concurrency:
  //
  // 1. **Fresh snapshot every round, not once up front** (now inside drainBranches() above). The
  //    old version computed `remaining` ONCE from a single listByProject() call, then only ever
  //    removed entries from that in-memory Map — a branch created by a concurrent request AFTER
  //    that snapshot (but before this loop finished) was invisible to it for the rest of the call,
  //    silently surviving the project delete and then throwing an FK constraint on the final
  //    projects.delete() below (or worse, succeeding in some interleaving and orphaning a branch
  //    row against a now-gone project). `state.branches.listByProject()` is now re-queried at the
  //    TOP of every `while` iteration, so a branch that appears mid-delete is simply picked up as
  //    a leaf in a later round — no special-casing needed, the loop is naturally self-correcting.
  // 2. **Per-leaf teardown now runs inside `queue.run(leaf.id, ...)`** — the exact same lane
  //    BranchesService.create/delete and EndpointsService.start/stop already serialize through for
  //    that branch id. Previously this loop's stop()/timelineDelete()/branches.delete() sequence
  //    ran completely outside any lane, so it could interleave arbitrarily with a concurrent
  //    endpoint start/stop or a child create() on the same branch. Every mutation now happens with
  //    that branch's lane held, so a concurrent operation on the same leaf either finishes first
  //    or waits its turn — never both touching the branch at once.
  async delete(id: string): Promise<void> {
    const project = this.byIdOr404(id);
    await this.drainBranches(project.id);
    // oracle: src/mgmt/service/project.rs:351-395
    await this.deps.pageserver.tenantDelete(project.id);
    await this.deps.safekeeper.tenantDelete(project.id);
    // Fix 1 (review): bounded retry (3 sweeps) around the final row-delete. drainBranches() above
    // re-snapshots on every round, so by the time we reach here the project's branches should be
    // gone — but a branch created in the narrow window between drainBranches()'s LAST empty
    // snapshot and this very line (e.g. a create() that slipped in after that loop observed zero
    // remaining branches, but before this statement runs) would make projects.delete() throw an FK
    // constraint. Rather than surface that as a raw SQLite error, re-run the exact same
    // children-first drain a few more times — cheap in the common case (an immediate empty
    // listByProject() inside drainBranches()) and only does real work in the rare case a row
    // genuinely appeared at the last second.
    const MAX_FINAL_SWEEPS = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        this.deps.state.projects.delete(project.id);
        this.deps.events?.publish({ type: "project.deleted", projectId: project.id });
        return;
      } catch (e) {
        const isFkViolation = (e as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT");
        if (!isFkViolation || attempt >= MAX_FINAL_SWEEPS) throw e;
        this.deps.logger.error(
          `projects.delete(${project.id}): FK constraint on final row-delete (attempt ${attempt}/${MAX_FINAL_SWEEPS}) — a branch likely appeared after the last sweep; re-draining`,
          e,
        );
        await this.drainBranches(project.id);
      }
    }
  }
}
