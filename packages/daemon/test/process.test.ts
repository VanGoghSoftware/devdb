import { describe, expect, it } from "vitest";
import { ManagedProcess } from "../src/engine/process.js";

const node = process.execPath;

describe("ManagedProcess", () => {
  it("start resolves when needle appears and captures lines", async () => {
    const p = new ManagedProcess({
      name: "fake", bin: node,
      args: ["-e", "console.log('booting'); console.log('READY now'); setInterval(()=>{},1000)"],
      readyNeedle: "READY",
    });
    await p.start();
    expect(p.state).toBe("running");
    expect(p.recentLines(10).join("\n")).toContain("booting");
    await p.stop();
    expect(p.state).toBe("stopped");
  });

  it("start rejects when process exits before needle", async () => {
    const p = new ManagedProcess({
      name: "dies", bin: node, args: ["-e", "console.log('nope')"],
      readyNeedle: "READY", readyTimeoutMs: 5000,
    });
    await expect(p.start()).rejects.toThrow(/exited|READY/);
    expect(p.state).toBe("failed");
  });

  it("start rejects on timeout", async () => {
    const p = new ManagedProcess({
      name: "slow", bin: node, args: ["-e", "setInterval(()=>{},1000)"],
      readyNeedle: "READY", readyTimeoutMs: 300,
    });
    await expect(p.start()).rejects.toThrow(/timed out/i);
    await p.stop();
  });

  it("stop escalates to SIGKILL", async () => {
    const p = new ManagedProcess({
      name: "stubborn", bin: node,
      args: ["-e", "process.on('SIGTERM',()=>{}); console.log('READY'); setInterval(()=>{},1000)"],
      readyNeedle: "READY",
    });
    await p.start();
    await p.stop(500);
    expect(p.state).toBe("stopped");
  });
});
