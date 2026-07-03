import type { BranchRow } from "../state/repos.js";
import type { BranchQueue } from "../state/queue.js";
import { newHexId } from "../engine/ids.js";
import { EngineApiError } from "../engine/http.js";
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
//
// Guard placement note (review fix): resetToParent's children-exist and parent-exists checks
// used to run BEFORE the queued body, against a snapshot that could go stale while the caller
// waited in line for the branch's lane (e.g. a child branch created, or the parent deleted, in
// the gap between the check and the swap actually running). Both checks — and the branch's own
// re-read — now run INSIDE the lane, via the `preflight` hook below, so they see state as of the
// moment this operation actually executes, not as of when it was requested. restoreInPlace's LSN
// resolution stays OUTSIDE the lane (the LSN is time-anchored, not state-anchored — a fresh lane
// re-read can't change what timestamp the caller asked for), but its branch re-read inside the
// lane (byIdOr404 at the top of swapOntoNewTimeline's queued body) remains as before.
export class TimeTravelService {
  constructor(private deps: ProjectsDeps & {
    queue: BranchQueue; branches: BranchesService; endpoints: EndpointsLockedApi;
  }) {}

  // oracle: src/mgmt/service/branch.rs:520-599 (via storcon :1234, which proxies the pageserver's
  // get_lsn_by_timestamp route).
  async lsnAtTimestamp(branchId: string, isoTimestamp: string): Promise<string> {
    const branch = this.deps.branches.byIdOr404(branchId);
    // Review fix: require an explicit timezone (Z or ±HH:MM) rather than accepting whatever
    // `new Date(...)` parses. A bare "2026-07-02T10:00:00" (no offset) is silently interpreted
    // in the SERVER's local timezone by the Date constructor — for a PITR timestamp that's a
    // correctness trap, not just a style nit: the same string resolves to a different instant
    // depending on which machine runs the daemon, and the resulting LSN would be resolved
    // against the wrong point in time with no error to signal the mismatch.
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(isoTimestamp)) {
      throw new DevdbError(400, "timestamp must include an explicit timezone (Z or ±HH:MM)");
    }
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
    try {
      return await this.deps.branches.create({
        projectId: a.projectId, name: a.name, parentBranchId: a.sourceBranchId,
        atLsn: lsn, createdBy: a.createdBy ?? "api",
      });
    } catch (e) {
      throw this.classifyLsnRangeError(e);
    }
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
  //
  // Review fix: the parent-exists / no-parent / children-exist checks now run inside the queued
  // lane via `preflight` (see the class-level comment) instead of before swapOntoNewTimeline is
  // even called — this method itself no longer touches branch/parent/children state at all.
  async resetToParent(branchId: string): Promise<BranchDetail> {
    return this.swapOntoNewTimeline(branchId, {
      atLsn: null,
      archiveTag: "reset",
      detachAncestor: false,
      preflight: (branch) => {
        if (!branch.parentBranchId) throw new DevdbError(400, `branch "${branch.name}" has no parent`);
        const children = this.deps.state.branches.listByParent(branch.id);
        if (children.length > 0) {
          throw new DevdbError(409,
            `branch "${branch.name}" has child branches: ${children.map((c) => c.name).join(", ")} — delete them first`);
        }
        const parent = this.deps.branches.byIdOr404(branch.parentBranchId);
        return { ancestorTimelineId: parent.timelineId };
      },
    });
  }

  // oracle: neond branch.rs:689-701 classifies engine LSN-range failures (out-of-range,
  // not-found-at-that-point, malformed) at create-at-LSN time into a distinct PITR-range error
  // rather than a generic 5xx passthrough — the requested point simply isn't materializable on
  // this branch's history, which is a client-actionable 400, not a server fault. Any other
  // EngineApiError (auth, unreachable, unrelated 5xx, etc.) is a real engine/infra problem and
  // must NOT be reclassified — only the LSN-range-shaped subset is oracle-mapped here.
  private classifyLsnRangeError(e: unknown): unknown {
    if (!(e instanceof EngineApiError)) return e;
    const text = `${e.body} ${e.message}`;
    if (/lsn|out of range|bad request|not found/i.test(text)) {
      return new DevdbError(400, `target point not available on this branch: ${e.body.slice(0, 300)}`);
    }
    return e;
  }

  private async swapOntoNewTimeline(branchId: string, opts: {
    ancestorTimelineId?: (b: BranchRow) => string;
    atLsn: string | null;
    archiveTag: string;
    detachAncestor: boolean;
    // Runs INSIDE the queued lane, after the fresh branch re-read and before anything else
    // touches engine or DB state. Lets callers (resetToParent) do their state-dependent guard
    // checks (children exist? parent still there?) against lane-fresh data and supply the
    // ancestor timeline id computed from that fresh read, instead of computing it from a
    // pre-queue snapshot that could have gone stale while waiting in line for this branch's lane.
    preflight?: (branch: BranchRow) => { ancestorTimelineId: string };
  }): Promise<BranchDetail> {
    return this.deps.queue.run(branchId, async (lane) => {
      const branch = this.deps.branches.byIdOr404(branchId);
      const ancestorTimelineId = opts.preflight
        ? opts.preflight(branch).ancestorTimelineId
        : opts.ancestorTimelineId!(branch);
      const status = this.deps.computes.statusOf(branch.id);
      if (status === "starting" || status === "stopping") {
        throw new DevdbError(409, "endpoint is mid-transition — retry when it settles");
      }
      const wasRunning = status === "running";
      // Stop through EndpointsLockedApi (not raw computes.stop) so the old row's endpoint_status
      // persists the same starting/stopping/stopped bookkeeping a normal stop() would — this row
      // is about to be renamed to its archived identity, but its endpoint lifecycle history
      // should stay coherent up to that point.
      if (wasRunning) await this.deps.endpoints.stopLocked(lane, branch.id);

      const newTimelineId = newHexId();
      // Review fix: the ORIGINAL failure-handling only compensated a failed detachAncestor call.
      // ANY failure in this block — timelineCreate, detachAncestor, or restoreSwap — now gets the
      // identical compensation: best-effort delete the (possibly never fully created) new
      // timeline on both engine components, restart the original endpoint if it was running,
      // rethrow. `newTimelineCreated` tracks whether the delete calls even need to run (skip them
      // if timelineCreate itself never succeeded — nothing to delete yet). Deliberately scoped to
      // stop at restoreSwap: once restoreSwap has returned, branch.id IS the archived identity and
      // newTimelineId IS the live swapped branch's timeline — a failure in the startLocked() call
      // AFTER this block (below) is a different failure domain entirely (the swap already
      // succeeded) and must not trigger "delete newTimelineId" / "restart branch.id" compensation,
      // which would target the wrong (now-archived) identity and the wrong (now-live) timeline.
      // See the crash-window comment below for that separate, currently-unhandled gap.
      let newTimelineCreated = false;
      let swapped: BranchRow;
      try {
        const req: { new_timeline_id: string } & Record<string, unknown> = {
          new_timeline_id: newTimelineId,
          ancestor_timeline_id: ancestorTimelineId,
          read_only: false,
        };
        if (opts.atLsn) req.ancestor_start_lsn = opts.atLsn;
        try {
          await this.deps.pageserver.timelineCreate(branch.projectId, req);
        } catch (e) {
          throw opts.atLsn ? this.classifyLsnRangeError(e) : e;
        }
        newTimelineCreated = true;

        let reparented: string[] = [];
        if (opts.detachAncestor) {
          const out = await this.deps.pageserver.timelineDetachAncestor(branch.projectId, newTimelineId);
          reparented = out.reparented_timelines;
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        swapped = this.deps.state.branches.restoreSwap({
          oldBranchId: branch.id,
          newBranchId: crypto.randomUUID(),
          newTimelineId,
          archiveName: `${branch.name}_${opts.archiveTag}_archived_${stamp}`,
          archiveSlug: `${slugify(branch.slug)}-${opts.archiveTag}-${newTimelineId.slice(0, 6)}`,
          reparentedTimelineIds: reparented,
        });
      } catch (e) {
        // oracle cleanup: branch.rs:709-735 — never leave an orphaned half-created timeline
        // behind when ANY step above fails (timelineCreate, detachAncestor, or restoreSwap) —
        // best-effort delete on both engine components, loud on failure rather than silently
        // swallowed (same discipline as BranchesService.create's and ProjectsService.create's own
        // compensation paths).
        if (newTimelineCreated) {
          await this.deps.pageserver.timelineDelete(branch.projectId, newTimelineId).catch((c) =>
            console.error(`compensation failed — orphaned timeline ${newTimelineId} on pageserver:`, c));
          await this.deps.safekeeper.timelineDelete(branch.projectId, newTimelineId).catch((c) =>
            console.error(`compensation failed — orphaned timeline ${newTimelineId} on safekeeper:`, c));
        }
        // The swap never happened on any path that reaches here — restoreSwap is the last
        // operation in the try block above, so branch.id is still the original, unchanged
        // identity. A failed restore/reset attempt must not have the side effect of leaving a
        // previously-running endpoint stopped: restart it before rethrowing, best-effort (loud on
        // failure, not swallowed — same discipline as the two deletes above).
        if (wasRunning) {
          await this.deps.endpoints.startLocked(lane, branch.id).catch((c) =>
            console.error(`compensation failed — endpoint for branch ${branch.id} not restarted after a failed restore:`, c));
        }
        throw e;
      }

      // Crash-window note (review fix, tracked for the durability phase — not fixed here):
      // process death between a successful detach_ancestor and this DB swap leaves a detached
      // orphan timeline and (if wasRunning) a stopped endpoint; no boot reconciliation exists
      // yet — tracked for the durability phase.
      // swapped.id is a fresh identity restoreSwap just minted; acquire ITS lane (uncontended —
      // nothing else can reference it yet) so this start is serialized under the branch it
      // actually targets, not the now-archived branchId lane we still hold. Closes the
      // "empty-lane micro-window" deferred to phase 2 in handover §9.
      if (wasRunning) {
        await this.deps.queue.run(swapped.id, (lane2) => this.deps.endpoints.startLocked(lane2, swapped.id));
      }
      return this.deps.branches.detail(this.deps.branches.byIdOr404(swapped.id));
    });
  }
}
