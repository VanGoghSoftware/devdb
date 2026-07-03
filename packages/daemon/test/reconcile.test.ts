import { describe, expect, it } from "vitest";
import { openState } from "../src/state/db.js";
import { reconcileEndpointsOnBoot } from "../src/state/reconcile.js";

function freshState() {
  return openState(":memory:");
}

function seedBranch(s: ReturnType<typeof freshState>, projectId: string, name: string) {
  return s.branches.create({
    id: crypto.randomUUID(), projectId, parentBranchId: null,
    name, slug: `${projectId.slice(0, 6)}-${name}`, timelineId: crypto.randomUUID().replace(/-/g, ""),
    password: "pw", createdBy: "api",
  });
}

// Fix 4 (review): reconcileEndpointsOnBoot() extracted from index.ts's inline boot loop into its
// own module specifically so these transition rules have direct unit coverage — previously the
// only way to exercise this logic was a live daemon boot (via a real openState() + full main()
// run) or a container-restart integration test (tests/integration/restart.test.ts), neither of
// which can cheaply cover every starting endpoint_status value or the endpoint_error-preservation
// rule in isolation.
describe("reconcileEndpointsOnBoot", () => {
  // Reconciliation passes `port: null` to updateEndpoint() for every non-stopped row (matching
  // the observable-port contract this is meant to enforce: ComputeManager always starts a boot
  // with an empty in-memory map, so BranchesService.detail()'s live `port` — read from
  // computes.portOf(), NOT the DB row — is null for every branch regardless of what's persisted).
  // stickyPort itself is a SEPARATE, deliberately-persistent column (BranchesRepo.updateEndpoint's
  // own doc comment: `sticky_port = COALESCE(?, sticky_port)`) that survives a null `port` write by
  // design — it's the port a branch tries to reclaim on its NEXT start, not live state — so this
  // test asserts status transitions to "stopped" across every non-stopped status value, without
  // asserting stickyPort is cleared (it correctly is not).
  it("resets running/starting/stopping/failed rows to stopped for every status value", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });

    const statuses = ["running", "starting", "stopping", "failed"] as const;
    const branches = statuses.map((status) => {
      const b = seedBranch(s, p.id, status);
      s.branches.updateEndpoint(b.id, { status, port: 54300 });
      return b;
    });

    reconcileEndpointsOnBoot(s);

    for (const b of branches) {
      const row = s.branches.byId(b.id)!;
      expect(row.endpointStatus).toBe("stopped");
    }
  });

  // The COALESCE-preserving counterpart to the test above, made explicit: a branch's stickyPort
  // (the port it will try to reclaim on its next start) must survive reconciliation's `port: null`
  // write untouched — reconciliation resets STATUS, not the persistent sticky-port assignment.
  it("preserves stickyPort through reconciliation's port:null write (COALESCE, not clear)", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });
    const b = seedBranch(s, p.id, "main");
    s.branches.updateEndpoint(b.id, { status: "running", port: 54300 });
    expect(s.branches.byId(b.id)!.stickyPort).toBe(54300);

    reconcileEndpointsOnBoot(s);

    expect(s.branches.byId(b.id)!.stickyPort).toBe(54300);
  });

  it("leaves an already-stopped row untouched (no spurious updated_at bump)", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });
    const b = seedBranch(s, p.id, "main");
    // main is created already at "stopped" — capture updated_at before reconciliation runs.
    const before = s.branches.byId(b.id)!.updatedAt;

    reconcileEndpointsOnBoot(s);

    const after = s.branches.byId(b.id)!;
    expect(after.endpointStatus).toBe("stopped");
    expect(after.updatedAt).toBe(before);
  });

  it("preserves endpoint_error through reconciliation instead of clearing it", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });
    const b = seedBranch(s, p.id, "dev");
    s.branches.updateEndpoint(b.id, {
      status: "failed", port: null, error: "compute_ctl exited before ready",
    });

    reconcileEndpointsOnBoot(s);

    const row = s.branches.byId(b.id)!;
    expect(row.endpointStatus).toBe("stopped");
    expect(row.endpointError).toBe("compute_ctl exited before ready");
  });

  it("reconciles across every project, not just the first", () => {
    const s = freshState();
    const p1 = s.projects.create({ id: "a".repeat(32), name: "one", pgVersion: 17 });
    const p2 = s.projects.create({ id: "b".repeat(32), name: "two", pgVersion: 17 });
    const b1 = seedBranch(s, p1.id, "main");
    const b2 = seedBranch(s, p2.id, "main");
    s.branches.updateEndpoint(b1.id, { status: "running", port: 54300 });
    s.branches.updateEndpoint(b2.id, { status: "starting", port: null });

    reconcileEndpointsOnBoot(s);

    expect(s.branches.byId(b1.id)!.endpointStatus).toBe("stopped");
    expect(s.branches.byId(b2.id)!.endpointStatus).toBe("stopped");
  });

  it("a branch with no endpoint_error keeps it null (not accidentally set)", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });
    const b = seedBranch(s, p.id, "main");
    s.branches.updateEndpoint(b.id, { status: "running", port: 54300 });
    expect(s.branches.byId(b.id)!.endpointError).toBeNull();

    reconcileEndpointsOnBoot(s);

    expect(s.branches.byId(b.id)!.endpointError).toBeNull();
  });
});
