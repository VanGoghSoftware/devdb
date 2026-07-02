import type { BranchRow } from "../state/repos.js";
import type { BranchQueue } from "../state/queue.js";
import { newHexId } from "../engine/ids.js";
import { DevdbError } from "./errors.js";
import { slugify } from "./slug.js";
import type { ProjectsDeps } from "./projects.js";
import type { BranchesService, BranchDetail } from "./branches.js";
import type { EndpointsLockedApi } from "./endpoints.js";

// oracle (neond): restore = new timeline branched at the target LSN from the branch's OWN
// timeline → timeline_detach_ancestor (reparents children) → DB identity swap archiving the old
// row. reset = fresh fork of the PARENT's current head + the same identity swap, NO detach
// (the new timeline's ancestor already IS the parent — that's the correct final shape).
//
// Deadlock note: swapOntoNewTimeline() runs its body inside `this.deps.queue.run(branchId, ...)`
// to serialize with any concurrent start()/stop()/delete() for this branch (same discipline as
// BranchesService.create/delete and EndpointsService.start/stop). Calling the PUBLIC, ALSO-queued
// EndpointsService.start()/stop() from inside that lane would be a second queue.run() for the
// same branchId nested inside the first: BranchQueue.run() chains onto the existing tail promise,
// so the inner call could only proceed once the outer settles — but the outer is awaiting the
// inner. That's a real deadlock, not a hypothetical one. The fix: depend on EndpointsLockedApi
// (just startLocked/stopLocked, the unqueued internals) instead of the concrete EndpointsService,
// and call those directly from within the lane this service already holds.
export class TimeTravelService {
  constructor(private deps: ProjectsDeps & {
    queue: BranchQueue; branches: BranchesService; endpoints: EndpointsLockedApi;
  }) {}

  // oracle: src/mgmt/service/branch.rs:520-599 (via storcon :1234, which proxies the pageserver's
  // get_lsn_by_timestamp route).
  async lsnAtTimestamp(branchId: string, isoTimestamp: string): Promise<string> {
    const branch = this.deps.branches.byIdOr404(branchId);
    const ts = new Date(isoTimestamp);
    if (Number.isNaN(ts.getTime())) throw new DevdbError(400, `invalid timestamp: ${isoTimestamp}`);
    const out = await this.deps.storcon.getLsnByTimestamp(
      branch.projectId, branch.timelineId, ts.toISOString());
    if (out.kind !== "present") {
      const why = out.kind === "future"
        ? "that timestamp is ahead of this branch's history"
        : "that timestamp is before this branch's retained history";
      throw new DevdbError(400, `cannot resolve ${isoTimestamp} on "${branch.name}": ${why} (kind=${out.kind})`);
    }
    return out.lsn;
  }

  // Non-destructive PITR: a new, ordinary branch at the resolved LSN. Nothing about the source
  // branch changes — this is BranchesService.create() with atLsn wired from lsnAtTimestamp().
  async branchAtTimestamp(a: {
    projectId: string; sourceBranchId: string; name: string; isoTimestamp: string;
    createdBy?: "ui" | "api" | "mcp";
  }): Promise<BranchRow> {
    const lsn = await this.lsnAtTimestamp(a.sourceBranchId, a.isoTimestamp);
    return this.deps.branches.create({
      projectId: a.projectId, name: a.name, parentBranchId: a.sourceBranchId,
      atLsn: lsn, createdBy: a.createdBy ?? "api",
    });
  }

  // oracle: src/mgmt/service/branch.rs:601-848 restore(): new timeline at LSN from the
  // branch's own timeline → detach_ancestor (reparents children) → DB identity swap, old row
  // archived as <name>_pitr_archived_<ts>; endpoint stopped/relaunched around it.
  async restoreInPlace(branchId: string, isoTimestamp: string): Promise<BranchDetail> {
    const lsn = await this.lsnAtTimestamp(branchId, isoTimestamp);
    return this.swapOntoNewTimeline(branchId, {
      ancestorTimelineId: (b) => b.timelineId,
      atLsn: lsn,
      archiveTag: "pitr",
      detachAncestor: true,
    });
  }

  // reset = fresh fork of the parent's current head, same swap machinery.
  // No detach_ancestor: the new timeline's ancestor IS the parent (correct final shape) — there
  // is no orphaned ancestor chain to collapse, unlike restoreInPlace's own-timeline branch-point.
  async resetToParent(branchId: string): Promise<BranchDetail> {
    const branch = this.deps.branches.byIdOr404(branchId);
    if (!branch.parentBranchId) throw new DevdbError(400, `branch "${branch.name}" has no parent`);
    const children = this.deps.state.branches.listByParent(branch.id);
    if (children.length > 0) {
      throw new DevdbError(409,
        `branch "${branch.name}" has child branches: ${children.map((c) => c.name).join(", ")} — delete them first`);
    }
    const parent = this.deps.branches.byIdOr404(branch.parentBranchId);
    return this.swapOntoNewTimeline(branchId, {
      ancestorTimelineId: () => parent.timelineId,
      atLsn: null,
      archiveTag: "reset",
      detachAncestor: false,
    });
  }

  private async swapOntoNewTimeline(branchId: string, opts: {
    ancestorTimelineId: (b: BranchRow) => string;
    atLsn: string | null;
    archiveTag: string;
    detachAncestor: boolean;
  }): Promise<BranchDetail> {
    return this.deps.queue.run(branchId, async () => {
      const branch = this.deps.branches.byIdOr404(branchId);
      const status = this.deps.computes.statusOf(branch.id);
      if (status === "starting" || status === "stopping") {
        throw new DevdbError(409, "endpoint is mid-transition — retry when it settles");
      }
      const wasRunning = status === "running";
      // Stop through EndpointsLockedApi (not raw computes.stop) so the old row's endpoint_status
      // persists the same starting/stopping/stopped bookkeeping a normal stop() would — this row
      // is about to be renamed to its archived identity, but its endpoint lifecycle history
      // should stay coherent up to that point.
      if (wasRunning) await this.deps.endpoints.stopLocked(branch.id);

      const newTimelineId = newHexId();
      const req: { new_timeline_id: string } & Record<string, unknown> = {
        new_timeline_id: newTimelineId,
        ancestor_timeline_id: opts.ancestorTimelineId(branch),
        read_only: false,
      };
      if (opts.atLsn) req.ancestor_start_lsn = opts.atLsn;
      await this.deps.pageserver.timelineCreate(branch.projectId, req);

      let reparented: string[] = [];
      if (opts.detachAncestor) {
        try {
          const out = await this.deps.pageserver.timelineDetachAncestor(branch.projectId, newTimelineId);
          reparented = out.reparented_timelines;
        } catch (e) {
          // oracle cleanup: branch.rs:709-735 — never leave an orphaned half-created timeline
          // behind when detach fails; best-effort delete on both engine components, loud on
          // failure rather than silently swallowed (same discipline as BranchesService.create's
          // and ProjectsService.create's own compensation paths).
          await this.deps.pageserver.timelineDelete(branch.projectId, newTimelineId).catch((c) =>
            console.error(`compensation failed — orphaned timeline ${newTimelineId} on pageserver:`, c));
          await this.deps.safekeeper.timelineDelete(branch.projectId, newTimelineId).catch((c) =>
            console.error(`compensation failed — orphaned timeline ${newTimelineId} on safekeeper:`, c));
          // The swap never happened (restoreSwap runs after this block) — branch.id is still the
          // original, unchanged identity. A failed restore attempt must not have the side effect
          // of leaving a previously-running endpoint stopped: restart it before rethrowing, best-
          // effort (loud on failure, not swallowed — same discipline as the two deletes above).
          if (wasRunning) {
            await this.deps.endpoints.startLocked(branch.id).catch((c) =>
              console.error(`compensation failed — endpoint for branch ${branch.id} not restarted after a failed restore:`, c));
          }
          throw e;
        }
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const swapped = this.deps.state.branches.restoreSwap({
        oldBranchId: branch.id,
        newBranchId: crypto.randomUUID(),
        newTimelineId,
        archiveName: `${branch.name}_${opts.archiveTag}_archived_${stamp}`,
        archiveSlug: `${slugify(branch.slug)}-${opts.archiveTag}-${newTimelineId.slice(0, 6)}`,
        reparentedTimelineIds: reparented,
      });

      if (wasRunning) await this.deps.endpoints.startLocked(swapped.id);
      return this.deps.branches.detail(this.deps.branches.byIdOr404(swapped.id));
    });
  }
}
