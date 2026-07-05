import type { BranchQueue, Lane } from "../state/queue.js";
import { PortExhaustedError } from "../compute/ports.js";
import { DevdbError } from "./errors.js";
import type { ProjectsDeps } from "./projects.js";
import type { BranchesService, BranchDetail } from "./branches.js";
import type { LogsService } from "./logs.js";
import type { BuildsResolverApi } from "./engine-api.js";

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
  startLocked(lane: Lane, branchId: string, opts?: { pgbinPath?: string }): Promise<BranchDetail>;
  stopLocked(lane: Lane, branchId: string): Promise<BranchDetail>;
}

export class EndpointsService {
  constructor(private deps: ProjectsDeps & { queue: BranchQueue; branches: BranchesService; logs: LogsService; builds: BuildsResolverApi }) {}

  // Every endpoint status persisted to SQLite is also announced on /api/events — one seam so a
  // transition can never be written without being announced (spec Decision 1 emission table).
  // All six updateEndpoint call sites in this file route through here (including the two
  // compensation-path calls, which stay inside their own try/catch — this helper just goes
  // inside that existing wrapping).
  private setEndpointStatus(
    branch: { id: string; projectId: string },
    a: { status: string; port: number | null; error?: string | null },
  ): void {
    this.deps.state.branches.updateEndpoint(branch.id, a);
    this.deps.events?.publish({ type: "endpoint.status", projectId: branch.projectId, branchId: branch.id });
  }

  // Queued body shared by start()/ensureRunning() — see the comment on ensureRunning() for why
  // the idempotency check below must run INSIDE the queue lane rather than before it.
  //
  // Public (not private) with a `Locked` suffix + this doc: MUST be called only from a caller
  // that already holds this branchId's queue.run() lane (e.g. TimeTravelService's swap, which
  // queues under the same branchId to serialize with concurrent start()/stop()/delete() calls
  // for that branch). Calling it unqueued is a deliberate least-invasive alternative to plumbing
  // a second "already locked" queue primitive — see the EndpointsLockedApi comment above.
  async startLocked(lane: Lane, branchId: string, opts?: { pgbinPath?: string }): Promise<BranchDetail> {
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
    this.setEndpointStatus(branch, { status: "starting", port: null });
    try {
      // Dynamic builds: the ACTIVE build for this project's major, resolved fresh per start — this
      // is what makes "adopt on restart" structural (spec §Architecture). The validation gate
      // (startWithPgbin, below) passes an explicit override instead, and must NOT touch the run
      // high-water: the candidate isn't active yet — recording it would arm the downgrade guard
      // against a build that may fail its own gate. Resolved INSIDE this try (not before it) so a
      // pgbinFor() 409 ("no usable Postgres — pull one or pick an installed major") lands in the
      // SAME single "failed"-recording catch every other start() failure goes through below.
      const resolved = opts?.pgbinPath ? null : this.deps.builds.pgbinFor(project.pgVersion);
      const pgbinPath = opts?.pgbinPath ?? resolved!.path;
      // CONCURRENCY INVARIANT — load-bearing: do NOT insert an `await` between pgbinFor() above and
      // computes.start() below, and keep pgbinFor() synchronous. This start must make the chosen
      // build visible to runningPgbins() in the SAME synchronous tick it commits to it: computes.
      // start() reserves the map entry carrying this pgbinPath synchronously before its own first
      // await (manager.ts), and pgbinFor() only ever returns the ACTIVE build — so a build a compute
      // is starting on is already "in use" (assertRemovable's runningPgbins check) before any yield
      // point lets a concurrent provisioner.remove() rm its --pgbin dir. That synchronous span is
      // what keeps the endpoint-vs-build-lane rm race closed (verified not-reachable 2026-07-05:
      // controller analysis + review-broker adversarial scan); a yield inserted here re-opens it.
      // This startLocked no-await half is pinned by endpoints-service.test.ts "startLocked calls
      // computes.start() synchronously after pgbinFor()"; the ComputeManager reservation half by
      // manager.test.ts "publishes pgbinPath into runningPgbins() SYNCHRONOUSLY".
      // Fix 1: `onLine` is passed straight into computes.start() rather than subscribed after
      // the fact via a separate computes.onLine() call once start() resolves. ComputeManager
      // registers this listener at map-reservation time — before its own first await — so
      // output from the ENTIRE launch (including a failed launch's last lines, which is exactly
      // what a caller most wants to see in the logs channel to understand why) reaches
      // LogsService's `branch:<id>:compute` channel. The manager's own entry lifecycle (stop(),
      // delete(), or a failed start()'s cleanup) now owns this listener's cleanup — there is
      // nothing left for this service to unsubscribe on any stop path.
      const { port } = await this.deps.computes.start({
        branch, pgVersion: project.pgVersion, pgbinPath,
        onLine: (line) => this.deps.logs.ingest(`branch:${branch.id}:compute`, line),
      });
      try {
        this.setEndpointStatus(branch, { status: "running", port });
      } catch (persistErr) {
        // The compute is live but we failed to record it — leaving state at "starting" (or
        // worse, a half-written "running") would strand a running process the daemon no longer
        // believes exists. Best-effort tear the compute back down before surfacing the original
        // persist error. Fix wave 1, Fix 2: does NOT also record "failed" here — persistErr is
        // rethrown below straight into the OUTER catch, which is now the single place that
        // records "failed" (and publishes endpoint.status) for BOTH a compute-start failure and a
        // running-persist failure. The old code recorded "failed" here too, then rethrew into the
        // outer catch which recorded it AGAIN for the same error — one real transition, two
        // published events.
        await this.deps.computes.stop(branch.id).catch((stopErr) =>
          this.deps.logger.error(`compensation failed — orphaned compute for branch ${branch.id} after a persist failure`, stopErr));
        throw persistErr;
      }
      // Fix round 1 (compensation gaps, review of Task 8 commit 43ce4b7): recordRun MUST run only
      // AFTER the "running" persist has SUCCEEDED, and MUST be best-effort — swallowed here so its
      // failure can never reach the outer catch (which would record "failed" for a start that
      // genuinely succeeded, all while leaving the now-live compute stranded with no compensating
      // computes.stop() call, since the outer catch doesn't do that). recordRun is a raise-only
      // high-water write, advisory to the downgrade guard — losing one write is far cheaper than
      // tearing down (or mis-reporting) a healthy compute over it.
      if (resolved) {
        // Only for a non-override (real, ACTIVE-build) start — the gate's override start must
        // never raise the high-water; see the override's own comment above.
        try {
          const minor = Number(resolved.version.split(".")[1]);
          this.deps.builds.recordRun(project.pgVersion, minor);
        } catch (recordErr) {
          this.deps.logger.error(`recordRun failed (non-fatal) for branch ${branch.id}`, recordErr);
        }
      }
    } catch (e) {
      // Single "failed" recording point for startLocked: reached either directly (computes.start
      // itself threw, or the "starting" write threw) or via the inner catch above rethrowing a
      // running-persist failure. Either way `e` is the one error to record and surface.
      this.setEndpointStatus(branch, {
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

  // Gate-only queued entry point (builds/validate.ts, a later task). Deliberately NOT wired to any
  // route — launches a CANDIDATE build (opts.pgbinPath override) instead of resolving the
  // project's current ACTIVE build, so the validation gate can smoke-test a build before it's
  // promoted. See startLocked's own override-path comment for why this must not recordRun.
  startWithPgbin(branchId: string, pgbinPath: string): Promise<BranchDetail> {
    return this.deps.queue.run(branchId, (lane) => this.startLocked(lane, branchId, { pgbinPath }));
  }

  // Public for the same reason as startLocked() above — see EndpointsLockedApi's doc comment.
  async stopLocked(lane: Lane, branchId: string): Promise<BranchDetail> {
    this.deps.queue.assertLane(lane, branchId);
    const branch = this.deps.branches.byIdOr404(branchId);
    this.setEndpointStatus(branch, { status: "stopping", port: null });
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
      this.setEndpointStatus(branch, { status: "stopped", port: null });
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
