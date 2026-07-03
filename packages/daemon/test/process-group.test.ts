import { describe, expect, it } from "vitest";
import { ManagedProcess } from "../src/engine/process.js";
import { setTimeout as delay } from "node:timers/promises";

describe("ManagedProcess detached group kill", () => {
  it("terminates the process group (child + grandchild) on stop", async () => {
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
    await mp.stop(3000);
    await delay(200);
    // process.kill(pid, 0) throws ESRCH once the pid is gone
    expect(() => process.kill(grandPid, 0)).toThrow();
  });
});
