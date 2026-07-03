import { describe, expect, it } from "vitest";
import { ManagedProcess } from "../src/engine/process.js";
import { setTimeout as delay } from "node:timers/promises";

describe("ManagedProcess detached group kill", () => {
  it("terminates the process group (child + grandchild) on stop, resolving promptly (not the full timeout)", async () => {
    // parent prints its grandchild's pid, then both idle forever
    const script = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], { stdio: "ignore" });
      process.stdout.write("gpid:" + g.pid + "\\n");
      setInterval(()=>{},1e9);
    `;
    let grandPid = 0;
    const mp = new ManagedProcess({
      name: "detached-parent",
      bin: process.execPath, args: ["-e", script], detached: true,
      readyNeedle: "gpid:", readyTimeoutMs: 5000,
      onLine: (l) => { const m = l.match(/gpid:(\d+)/); if (m) grandPid = Number(m[1]); },
    });
    await mp.start();
    expect(grandPid).toBeGreaterThan(0);
    // Neither the leader nor its grandchild install a SIGTERM handler here, so both take the
    // default action (terminate) on the plain group SIGTERM — stop() must resolve as soon as the
    // group empties out, WITHOUT waiting out the full timeoutMs budget below. This is the
    // necessary complement to the crux "ignores SIGTERM" test: Fix 1's detached-path group-poll
    // loop must not turn every stop() into a fixed multi-second wait on the common case.
    const timeoutMs = 3000;
    const t0 = Date.now();
    await mp.stop(timeoutMs);
    const elapsedMs = Date.now() - t0;
    expect(elapsedMs).toBeLessThan(timeoutMs / 2);
    await delay(200);
    // process.kill(pid, 0) throws ESRCH once the pid is gone
    expect(() => process.kill(grandPid, 0)).toThrow();
  });

  // The crux regression test (Fix 1). Models compute_ctl (leader, exits almost instantly on
  // SIGTERM) orphaning a postgres-shaped grandchild that can outlive SIGTERM ("smart shutdown"
  // waiting for clients — here modeled as an unconditional ignore, the extreme case). Pre-fix,
  // stop() only awaits the LEADER's own "exit" event and clears the group-SIGKILL timer the
  // instant the leader exits — so a grandchild that ignores SIGTERM never receives the escalated
  // group SIGKILL and survives indefinitely. This test asserts the grandchild is actually DEAD
  // after stop() returns, which is only true if stop() escalates to a GROUP SIGKILL when the
  // group (not just the leader) is still alive at the deadline.
  //
  // Race note (found empirically while writing this test): the readiness needle must only fire
  // once the grandchild's SIGTERM handler is actually ARMED, not merely spawned — forking a new
  // node interpreter and reaching `process.on('SIGTERM', ...)` takes a few ms, and stop() can
  // otherwise land the group SIGTERM in that gap, killing the grandchild via the DEFAULT SIGTERM
  // disposition and producing a false pass that has nothing to do with SIGKILL escalation
  // (verified: with the handler-armed synchronization below, the pre-fix stop() correctly leaves
  // the grandchild alive; without it — e.g. reporting readiness right after `spawn()` returns —
  // this test passed even against the unmodified pre-fix code, for the wrong reason). So the
  // grandchild is piped (not `stdio: "ignore"`) and explicitly reports "armed" over a dedicated
  // pipe AFTER `process.on('SIGTERM', ...)` has been registered; only then does the child print
  // the `gpid:` readiness needle.
  it("escalates to group SIGKILL when a grandchild ignores SIGTERM and outlives the leader", async () => {
    // Child: installs NO signal handler of its own, so it takes the default SIGTERM action
    // (terminate) — modeling compute_ctl's near-instant exit on SIGTERM. Its grandchild installs
    // a SIGTERM handler that swallows the signal (so only SIGKILL can end it) and reports "armed"
    // on its own stdout pipe before the child forwards the readiness needle.
    //
    // The grandchild's own -e source is passed as a doubly-JS-escaped string literal (test file
    // source -> child's source -> grandchild's source), so it deliberately uses console.log
    // (which appends its own newline) instead of an explicit "\n" in a string literal — avoiding
    // a THIRD level of backslash-escaping arithmetic that is easy to get subtly wrong (this was
    // tried and produced a real SyntaxError in the grandchild: a literal "\n" here needs FOUR
    // backslashes at the test-file level to survive both re-parses intact).
    const script = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); console.log('armed'); setInterval(()=>{},1e9);",
      ], { stdio: ["ignore", "pipe", "ignore"] });
      g.stdout.on("data", (d) => {
        if (d.toString().includes("armed")) process.stdout.write("gpid:" + g.pid + "\\n");
      });
      setInterval(()=>{},1e9);
    `;
    let grandPid = 0;
    const mp = new ManagedProcess({
      name: "detached-parent-stubborn-grandchild",
      bin: process.execPath, args: ["-e", script], detached: true,
      readyNeedle: "gpid:", readyTimeoutMs: 5000,
      onLine: (l) => { const m = l.match(/gpid:(\d+)/); if (m) grandPid = Number(m[1]); },
    });
    await mp.start();
    expect(grandPid).toBeGreaterThan(0);
    // Short timeoutMs: the leader exits on SIGTERM almost instantly, well before this deadline,
    // but the grandchild ignores SIGTERM and is still alive when the deadline hits — only a
    // group-aware SIGKILL escalation at (or after) the deadline can kill it.
    await mp.stop(500);
    // Give the escalated SIGKILL a moment to actually land (kernel reap), same allowance the
    // sibling test above gives the plain-SIGTERM path.
    await delay(300);
    expect(() => process.kill(grandPid, 0)).toThrow();
  });

  // Fix 2: start()'s OWN failure/timeout cleanup (the catch block that fires when the readiness
  // needle never appears) must also be group-aware for a detached ManagedProcess. Pre-fix, that
  // catch called child.kill("SIGKILL") on the direct child only — a grandchild spawned before the
  // parent gave up waiting for readiness would be left running, orphaned, exactly like the stop()
  // bug Fix 1 closes, just on the start-failure path instead of the normal-shutdown path.
  it("start() failure cleanup group-kills a grandchild spawned before the readiness timeout", async () => {
    // Child: spawns a grandchild, reports its pid, then NEVER prints the readiness needle (models
    // a compute_ctl that spawns postgres but then hangs/crashes before "listening on IPv4
    // address") — forcing start()'s own timeout path to fire its failure cleanup.
    const script = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], { stdio: "ignore" });
      process.stdout.write("gpid:" + g.pid + "\\n");
      setInterval(()=>{},1e9);
    `;
    let grandPid = 0;
    const mp = new ManagedProcess({
      name: "detached-parent-never-ready",
      bin: process.execPath, args: ["-e", script], detached: true,
      // Needle that never appears in this child's output — guarantees start()'s own readiness
      // timeout (not the "gpid:" line) is what triggers the failure-cleanup catch.
      readyNeedle: "NEVER-APPEARS", readyTimeoutMs: 300,
      onLine: (l) => { const m = l.match(/gpid:(\d+)/); if (m) grandPid = Number(m[1]); },
    });
    await expect(mp.start()).rejects.toThrow(/timed out/i);
    expect(grandPid).toBeGreaterThan(0);
    // Give the (group-aware, post-fix) SIGKILL a moment to land.
    await delay(300);
    expect(() => process.kill(grandPid, 0)).toThrow();
  });
});
