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

  it("detects the needle on stderr", async () => {
    const p = new ManagedProcess({
      name: "stderr-ready", bin: node,
      args: ["-e", "console.error('READY on stderr'); setInterval(()=>{},1000)"],
      readyNeedle: "READY",
    });
    await p.start();
    expect(p.state).toBe("running");
    await p.stop();
  });

  it("onLine receives line and stream label", async () => {
    const got: Array<[string, string]> = [];
    const p = new ManagedProcess({
      name: "fanout", bin: node,
      args: ["-e", "console.log('out-line'); console.error('err-line'); console.log('READY'); setInterval(()=>{},1000)"],
      readyNeedle: "READY",
      onLine: (line, stream) => got.push([line, stream]),
    });
    await p.start();
    await p.stop();
    expect(got).toContainEqual(["out-line", "stdout"]);
    expect(got).toContainEqual(["err-line", "stderr"]);
  });

  it("a throwing onLine callback does not break the lifecycle", async () => {
    const p = new ManagedProcess({
      name: "bad-observer", bin: node,
      args: ["-e", "console.log('one'); console.log('READY'); setInterval(()=>{},1000)"],
      readyNeedle: "READY",
      onLine: () => { throw new Error("observer boom"); },
    });
    await p.start();
    expect(p.state).toBe("running");
    await p.stop();
    expect(p.state).toBe("stopped");
  });

  it("ring buffer truncates to 500 lines", async () => {
    const p = new ManagedProcess({
      name: "chatty", bin: node,
      args: ["-e", "for (let i=0;i<600;i++) console.log('line-'+i); console.log('READY'); setInterval(()=>{},1000)"],
      readyNeedle: "READY",
    });
    await p.start();
    await new Promise((r) => setTimeout(r, 200));
    const lines = p.recentLines(1000);
    expect(lines.length).toBeLessThanOrEqual(500);
    expect(lines).not.toContain("line-0");
    await p.stop();
  });

  it("a retried start after timeout stays tracked when the old child exits", async () => {
    const p = new ManagedProcess({
      name: "retry", bin: node,
      args: ["-e", "setInterval(()=>{},1000)"],
      readyNeedle: "READY", readyTimeoutMs: 200,
    });
    await expect(p.start()).rejects.toThrow(/timed out/i);
    const p2args = ["-e", "console.log('READY'); setInterval(()=>{},1000)"];
    (p as unknown as { opts: { args: string[] } }).opts.args = p2args;
    await p.start();
    expect(p.state).toBe("running");
    expect(p.pid).not.toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(p.state).toBe("running");
    expect(p.pid).not.toBeNull();
    await p.stop();
  });

  it("stop() resolves after a spawn error instead of hanging", async () => {
    const p = new ManagedProcess({
      name: "no-bin", bin: "/nonexistent/devdb-missing-binary",
      args: [], readyNeedle: "READY", readyTimeoutMs: 2000,
    });
    await expect(p.start()).rejects.toThrow(/spawn error|ENOENT/i);
    await expect(
      Promise.race([
        p.stop(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("stop() hung")), 1000)),
      ]),
    ).resolves.toBeUndefined();
  });

  it("a synchronous spawn throw leaves state failed, not starting", async () => {
    const p = new ManagedProcess({
      name: "sync-bad", bin: "", args: [], readyNeedle: "READY",
    });
    await expect(p.start()).rejects.toThrow(/spawn failed synchronously|invalid/i);
    expect(p.state).toBe("failed");
  });

  it("crash after readiness flips state to failed", async () => {
    const p = new ManagedProcess({
      name: "crasher", bin: node,
      args: ["-e", "console.log('READY'); setTimeout(()=>process.exit(1), 100)"],
      readyNeedle: "READY",
    });
    await p.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(p.state).toBe("failed");
    expect(p.pid).toBeNull();
  });

  it("stop() during starting wins the state transition", async () => {
    const p = new ManagedProcess({
      name: "aborted", bin: node,
      args: ["-e", "setInterval(()=>{},1000)"],
      readyNeedle: "READY", readyTimeoutMs: 5000,
    });
    const pending = p.start();
    await new Promise((r) => setTimeout(r, 100));
    await p.stop();
    await expect(pending).rejects.toThrow(/exited|before ready/i);
    expect(p.state).toBe("stopped");
  });

  it("onStateChange fires on every distinct transition, and observer throws are swallowed", async () => {
    const states: string[] = [];
    const p = new ManagedProcess({
      name: "fake", bin: node,
      args: ["-e", "console.log('booting'); console.log('READY now'); setInterval(()=>{},1000)"],
      readyNeedle: "READY",
      onStateChange: (s) => { states.push(s); if (s === "running") throw new Error("observer boom"); },
    });
    await p.start();          // starting -> running
    await p.stop();           // -> stopped
    expect(states).toEqual(["starting", "running", "stopped"]);
  });

  it("crash after readiness reports failed via onStateChange", async () => {
    const states: string[] = [];
    const p = new ManagedProcess({
      name: "crasher", bin: node,
      args: ["-e", "console.log('READY'); setTimeout(()=>process.exit(1), 100)"],
      readyNeedle: "READY",
      onStateChange: (s) => states.push(s),
    });
    await p.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(states).toEqual(["starting", "running", "failed"]);
  });
});
