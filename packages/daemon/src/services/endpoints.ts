import type { BranchQueue } from "../state/queue.js";
import { PortExhaustedError } from "../compute/ports.js";
import { DevdbError } from "./errors.js";
import type { ProjectsDeps } from "./projects.js";
import type { BranchesService, BranchDetail } from "./branches.js";

// TimeTravelService's swap (see services/timetravel.ts) must stop/restart a branch's endpoint
// from WITHIN its own queue.run(branchId, ...) lane. Calling the public, queued start()/stop()
// from in there would be a second queue.run() for the SAME branchId nested inside the first —
// BranchQueue.run() chains onto the existing tail promise, so the inner call can only proceed
// once the outer one settles, but the outer one is awaiting the inner one: a deadlock. This
// narrow interface names exactly the two unqueued internals a caller already holding the
// branch's lane may call directly, so a consumer never needs a concrete EndpointsService import.
export interface EndpointsLockedApi {
  startLocked(branchId: string): Promise<BranchDetail>;
  stopLocked(branchId: string): Promise<BranchDetail>;
}

export class EndpointsService {
  constructor(private deps: ProjectsDeps & { queue: BranchQueue; branches: BranchesService }) {}

  // Queued body shared by start()/ensureRunning() — see the comment on ensureRunning() for why
  // the idempotency check below must run INSIDE the queue lane rather than before it.
  //
  // Public (not private) with a `Locked` suffix + this doc: MUST be called only from a caller
  // that already holds this branchId's queue.run() lane (e.g. TimeTravelService's swap, which
  // queues under the same branchId to serialize with concurrent start()/stop()/delete() calls
  // for that branch). Calling it unqueued is a deliberate least-invasive alternative to plumbing
  // a second "already locked" queue primitive — see the EndpointsLockedApi comment above.
  async startLocked(branchId: string): Promise<BranchDetail> {
    const branch = this.deps.branches.byIdOr404(branchId);
    const project = this.deps.state.projects.byId(branch.projectId)!;
    if (this.deps.computes.statusOf(branch.id) === "running") {
      return this.deps.branches.detail(branch);
    }
    this.deps.state.branches.updateEndpoint(branch.id, { status: "starting", port: null });
    try {
      const { port } = await this.deps.computes.start({ branch, pgVersion: project.pgVersion });
      try {
        this.deps.state.branches.updateEndpoint(branch.id, { status: "running", port });
      } catch (persistErr) {
        // The compute is live but we failed to record it — leaving state at "starting" (or
        // worse, a half-written "running") would strand a running process the daemon no longer
        // believes exists. Best-effort tear the compute back down and mark the branch failed
        // before surfacing the original persist error.
        await this.deps.computes.stop(branch.id).catch((stopErr) =>
          console.error(`compensation failed — orphaned compute for branch ${branch.id} after a persist failure:`, stopErr));
        try {
          this.deps.state.branches.updateEndpoint(branch.id, {
            status: "failed", port: null,
            error: (persistErr as Error).message?.slice(0, 2000) ?? String(persistErr),
          });
        } catch (e2) {
          console.error(`compensation failed — could not persist "failed" status for branch ${branch.id}:`, e2);
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
    return this.deps.queue.run(branchId, () => this.startLocked(branchId));
  }

  // Public for the same reason as startLocked() above — see EndpointsLockedApi's doc comment.
  async stopLocked(branchId: string): Promise<BranchDetail> {
    const branch = this.deps.branches.byIdOr404(branchId);
    this.deps.state.branches.updateEndpoint(branch.id, { status: "stopping", port: null });
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
    return this.deps.queue.run(branchId, () => this.stopLocked(branchId));
  }

  // Runs the SAME queued body as start() rather than pre-checking statusOf() before queuing:
  // checking outside the lane would read a stale/racing status (another start()/stop() for this
  // branch could be in flight in the same queue lane), and calling this.start() from here would
  // be a second, separate queue.run() for the same branchId — safe with this queue's
  // promise-chaining implementation, but two logically-nested lane entries for one logical
  // operation is a footgun going forward. Sharing startLocked() keeps exactly one lane entry.
  ensureRunning(branchId: string): Promise<BranchDetail> {
    return this.deps.queue.run(branchId, () => this.startLocked(branchId));
  }
}
