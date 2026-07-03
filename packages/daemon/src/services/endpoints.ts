import type { BranchQueue, Lane } from "../state/queue.js";
import { PortExhaustedError } from "../compute/ports.js";
import { DevdbError } from "./errors.js";
import type { ProjectsDeps } from "./projects.js";
import type { BranchesService, BranchDetail } from "./branches.js";
import type { LogsService } from "./logs.js";

// TimeTravelService's swap (see services/timetravel.ts) must stop/restart a branch's endpoint
// from WITHIN its own queue.run(branchId, ...) lane. Calling the public, queued start()/stop()
// from in there would be a second queue.run() for the SAME branchId nested inside the first —
// BranchQueue.run() chains onto the existing tail promise, so the inner call can only proceed
// once the outer one settles, but the outer one is awaiting the inner one: a deadlock. This
// narrow interface names exactly the two unqueued internals a caller already holding the
// branch's lane may call directly, so a consumer never needs a concrete EndpointsService import.
//
// Lane capability (was JSDoc-only "caller must hold the branch lane"): both methods now REQUIRE
// the `Lane` BranchQueue.run() mints for its work fn's branchId, not just a bare branchId string.
// Because Lane is a branded type only constructable inside BranchQueue (state/queue.ts), the tsc
// gate proves at compile time that no caller can invoke these without having actually gone through
// a queue.run() for SOME branch — this.deps.queue.assertLane() (called first thing in both methods
// below) then proves at runtime that the lane held is CURRENTLY ACTIVE (still within its queue
// turn, not one that leaked out of a settled run() call) and for the SAME branchId being operated
// on (a caller could otherwise hold branch A's lane while passing branch B's id).
export interface EndpointsLockedApi {
  startLocked(lane: Lane, branchId: string): Promise<BranchDetail>;
  stopLocked(lane: Lane, branchId: string): Promise<BranchDetail>;
}

export class EndpointsService {
  constructor(private deps: ProjectsDeps & { queue: BranchQueue; branches: BranchesService; logs: LogsService }) {}

  // Queued body shared by start()/ensureRunning() — see the comment on ensureRunning() for why
  // the idempotency check below must run INSIDE the queue lane rather than before it.
  //
  // Public (not private) with a `Locked` suffix + this doc: MUST be called only from a caller
  // that already holds this branchId's queue.run() lane (e.g. TimeTravelService's swap, which
  // queues under the same branchId to serialize with concurrent start()/stop()/delete() calls
  // for that branch). Calling it unqueued is a deliberate least-invasive alternative to plumbing
  // a second "already locked" queue primitive — see the EndpointsLockedApi comment above.
  async startLocked(lane: Lane, branchId: string): Promise<BranchDetail> {
    this.deps.queue.assertLane(lane, branchId);
    const branch = this.deps.branches.byIdOr404(branchId);
    const project = this.deps.state.projects.byId(branch.projectId)!;
    // Read the status once and branch on that single snapshot below — calling statusOf() a
    // second time for the "failed" check would observe a DIFFERENT call than the "running" check
    // above against a fake/mock that returns different values per call (and is simply confusing
    // style against the real ComputeManager, even though that one is synchronous/stable per call).
    const status = this.deps.computes.statusOf(branch.id);
    if (status === "running") {
      return this.deps.branches.detail(branch);
    }
    // Fix 2 (review, final wave): a crashed compute leaves a "failed" manager entry — dead
    // compute_ctl/postgres that ComputeManager still believes occupies this branch's slot (map
    // entry, reserved ports, temp dir). Left alone, computes.start() below would throw `endpoint
    // for branch X already failed` (its own `existing` guard), so an agent polling /api/sql after
    // a crash could never recover the branch via the API — only a full daemon restart (which runs
    // reconcileEndpointsOnBoot) would clear it. stop() reaps the orphaned postgres, releases the
    // ports, removes the compute dir, and clears the map slot — verified clean on a "failed" entry
    // (ManagedProcess.stop() no-ops instantly since `this.child` is already null by the time a
    // process has transitioned to "failed" — see process.ts's exit handler) — so this start can
    // proceed exactly like a normal cold start right after. This is the recovery path for agents
    // polling /api/sql: a crashed branch becomes startable again through the same endpoint.
    if (status === "failed") {
      await this.deps.computes.stop(branch.id);
    }
    this.deps.state.branches.updateEndpoint(branch.id, { status: "starting", port: null });
    try {
      // Fix 1: `onLine` is passed straight into computes.start() rather than subscribed after
      // the fact via a separate computes.onLine() call once start() resolves. ComputeManager
      // registers this listener at map-reservation time — before its own first await — so
      // output from the ENTIRE launch (including a failed launch's last lines, which is exactly
      // what a caller most wants to see in the logs channel to understand why) reaches
      // LogsService's `branch:<id>:compute` channel. The manager's own entry lifecycle (stop(),
      // delete(), or a failed start()'s cleanup) now owns this listener's cleanup — there is
      // nothing left for this service to unsubscribe on any stop path.
      const { port } = await this.deps.computes.start({
        branch, pgVersion: project.pgVersion,
        onLine: (line) => this.deps.logs.ingest(`branch:${branch.id}:compute`, line),
      });
      try {
        this.deps.state.branches.updateEndpoint(branch.id, { status: "running", port });
      } catch (persistErr) {
        // The compute is live but we failed to record it — leaving state at "starting" (or
        // worse, a half-written "running") would strand a running process the daemon no longer
        // believes exists. Best-effort tear the compute back down and mark the branch failed
        // before surfacing the original persist error.
        await this.deps.computes.stop(branch.id).catch((stopErr) =>
          this.deps.logger.error(`compensation failed — orphaned compute for branch ${branch.id} after a persist failure`, stopErr));
        try {
          this.deps.state.branches.updateEndpoint(branch.id, {
            status: "failed", port: null,
            error: (persistErr as Error).message?.slice(0, 2000) ?? String(persistErr),
          });
        } catch (e2) {
          this.deps.logger.error(`compensation failed — could not persist "failed" status for branch ${branch.id}`, e2);
        }
        throw persistErr;
      }
    } catch (e) {
      this.deps.state.branches.updateEndpoint(branch.id, {
        status: "failed", port: null,
        error: (e as Error).message?.slice(0, 2000) ?? String(e),
      });
      if (e instanceof PortExhaustedError) {
        // Project-qualify each running entry (projectName/branchName) so a 409 across multiple
        // projects doesn't read as ambiguous "main, main, main" — fall back to the bare branch
        // name (or raw id) if either lookup misses, rather than dropping the entry.
        const running = this.deps.computes.runningPorts().map((r) => {
          const b = this.deps.state.branches.byId(r.branchId);
          if (!b) return r.branchId;
          const p = this.deps.state.projects.byId(b.projectId);
          return p ? `${p.name}/${b.name}` : b.name;
        });
        throw new DevdbError(409,
          `no free endpoint port in range — running endpoints: ${running.join(", ")}. Stop one or widen DEVDB_PORT_RANGE.`);
      }
      throw e;
    }
    return this.deps.branches.detail(this.deps.branches.byIdOr404(branchId));
  }

  start(branchId: string): Promise<BranchDetail> {
    return this.deps.queue.run(branchId, (lane) => this.startLocked(lane, branchId));
  }

  // Public for the same reason as startLocked() above — see EndpointsLockedApi's doc comment.
  async stopLocked(lane: Lane, branchId: string): Promise<BranchDetail> {
    this.deps.queue.assertLane(lane, branchId);
    const branch = this.deps.branches.byIdOr404(branchId);
    this.deps.state.branches.updateEndpoint(branch.id, { status: "stopping", port: null });
    // Fix 1: no separate unsub bookkeeping here anymore — computes.stop() discards the whole
    // compute entry (including its listeners array, which now includes the onLine callback
    // passed into computes.start() above) unconditionally in its own finally block, so listener
    // cleanup is owned entirely by ComputeManager's entry lifecycle on every stop path (stop,
    // delete, or a failed start's own cleanup).
    try {
      await this.deps.computes.stop(branch.id);
    } finally {
      // manager.stop()'s own cleanup (map entry, ports, dir) is finally-guaranteed (A16), so by
      // the time this runs — even if computes.stop() above threw — the compute is truly gone.
      // "stopped" must land regardless, or a throwing proc-stop would strand the branch at
      // "stopping" forever with no way to retry (stop() short-circuits on nothing, but every
      // other transition reads this row as truth).
      this.deps.state.branches.updateEndpoint(branch.id, { status: "stopped", port: null });
    }
    return this.deps.branches.detail(this.deps.branches.byIdOr404(branchId));
  }

  stop(branchId: string): Promise<BranchDetail> {
    return this.deps.queue.run(branchId, (lane) => this.stopLocked(lane, branchId));
  }

  // Runs the SAME queued body as start() rather than pre-checking statusOf() before queuing:
  // checking outside the lane would read a stale/racing status (another start()/stop() for this
  // branch could be in flight in the same queue lane), and calling this.start() from here would
  // be a second, separate queue.run() for the same branchId — safe with this queue's
  // promise-chaining implementation, but two logically-nested lane entries for one logical
  // operation is a footgun going forward. Sharing startLocked() keeps exactly one lane entry.
  ensureRunning(branchId: string): Promise<BranchDetail> {
    return this.deps.queue.run(branchId, (lane) => this.startLocked(lane, branchId));
  }
}
