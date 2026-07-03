import type { StateDb } from "./db.js";

// Fix 4 (review): extracted from index.ts's boot sequence into its own testable function.
// Previously this logic only ran as a few inline lines inside main()'s try block — reachable
// only by actually booting the daemon (via a live openState() + full main() run, or an
// integration-test container restart), with no direct unit-test coverage of the branch-status
// transition rules on their own.
//
// Every branch row left at a non-"stopped" endpoint_status when the daemon (re)boots belongs to
// a compute process that died along with the previous container/process — ComputeManager always
// starts a fresh run with an empty in-memory map, so nothing is actually running regardless of
// what a persisted row claims. This resets status/port to reflect that reality. `endpoint_error`
// is diagnostic HISTORY, not live state, and is deliberately preserved through this reset — a
// branch that failed before the restart should still show why on next inspection, not have that
// context silently erased by the mere act of the daemon restarting.
export function reconcileEndpointsOnBoot(state: StateDb): void {
  for (const p of state.projects.list()) {
    for (const b of state.branches.listByProject(p.id)) {
      if (b.endpointStatus !== "stopped") {
        state.branches.updateEndpoint(b.id, { status: "stopped", port: null, error: b.endpointError });
      }
    }
  }
}
