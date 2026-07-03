import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
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

// Fix 4 (review, final wave): a compute mid-launch or mid-teardown at the moment the daemon
// container died unexpectedly (host reboot, `docker kill`, OOM — anything that skips the SIGTERM
// shutdown path's own ComputeManager.stopAll()) leaves its mkdtemp'd directory under computesDir
// behind on disk: pg_data, config.json, pg_hba.conf, all orphaned. Exactly like
// reconcileEndpointsOnBoot() above, ComputeManager always starts a fresh boot with an EMPTY
// in-memory map — nothing tracks these leftover directories, and no other code path ever revisits
// or cleans them, so they accumulate across restarts as pure disk waste. Placed beside
// reconcileEndpointsOnBoot() for the same reason: both are one-shot boot-time cleanup that must
// run before anything is live to race against — index.ts calls this immediately after
// reconcileEndpointsOnBoot(state), a point at which nothing can legitimately be running
// in-container (ComputeManager hasn't been constructed yet, let alone started anything).
//
// Deliberately tolerant of a missing computesDir (a fresh data volume with no computes ever
// started has no computes/ directory at all yet — not an error, just nothing to sweep) — every
// OTHER unexpected error (permissions, a genuinely corrupt path) is left to propagate rather than
// silently swallowed, since a boot-time cleanup step failing for a non-ENOENT reason is exactly
// the kind of thing that should surface loudly rather than be masked.
export async function sweepComputesDir(computesDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(computesDir);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return 0;
    throw e;
  }
  await Promise.all(entries.map((name) => rm(join(computesDir, name), { recursive: true, force: true })));
  return entries.length;
}
