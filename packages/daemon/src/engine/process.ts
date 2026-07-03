import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

export interface ManagedProcessOpts {
  name: string;
  bin: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  readyNeedle: string;
  readyTimeoutMs?: number;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  // When true, spawn as its own process-group leader (setsid-equivalent via Node's `detached`)
  // and signal the whole group (`process.kill(-pid, sig)`) on stop — not just the direct child.
  // compute_ctl orphans its postgres child on SIGTERM (never waits for it, never sets
  // PDEATHSIG/setpgid on it — handover §4.4/§8.6, confirmed live); without group semantics that
  // child is reparented to PID 1 and outlives stop() entirely. Only ComputeManager passes this;
  // the engine binaries (broker/storcon/pageserver/safekeeper) keep the default `false` — they
  // don't fork surviving children, so plain child-pid signaling is correct for them.
  detached?: boolean;
}

const RING_SIZE = 500;

export class ManagedProcess {
  state: "stopped" | "starting" | "running" | "failed" = "stopped";
  pid: number | null = null;
  private child: ChildProcess | null = null;
  private ring: string[] = [];

  constructor(private opts: ManagedProcessOpts) {}

  recentLines(n: number): string[] {
    return this.ring.slice(-n);
  }

  private ingest(line: string, stream: "stdout" | "stderr"): void {
    this.ring.push(line);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    try {
      this.opts.onLine?.(line, stream);
    } catch {
      // onLine fanout must never break the child lifecycle; observer errors are swallowed by contract.
    }
  }

  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error(`${this.opts.name} already ${this.state}`);
    }
    this.state = "starting";
    const timeoutMs = this.opts.readyTimeoutMs ?? 60_000;

    let child: ChildProcess;
    try {
      child = spawn(this.opts.bin, this.opts.args, {
        env: this.opts.env ?? {},
        cwd: this.opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: this.opts.detached ?? false,
      });
    } catch (e) {
      this.state = "failed";
      throw new Error(`${this.opts.name}: spawn failed synchronously: ${(e as Error).message}`);
    }
    this.child = child;
    this.pid = child.pid ?? null;

    let ready!: () => void;
    let failed!: (e: Error) => void;
    const readiness = new Promise<void>((res, rej) => {
      ready = res;
      failed = rej;
    });

    let seen = false;
    const rls: readline.Interface[] = [];
    const watch = (stream: NodeJS.ReadableStream | null, which: "stdout" | "stderr") => {
      if (!stream) return;
      const rl = readline.createInterface({ input: stream });
      rls.push(rl);
      rl.on("line", (line) => {
        this.ingest(line, which);
        if (!seen && line.includes(this.opts.readyNeedle)) {
          seen = true;
          ready();
        }
      });
    };
    watch(child.stdout, "stdout");
    watch(child.stderr, "stderr");

    const timer = setTimeout(() => {
      failed(new Error(`${this.opts.name}: timed out waiting for "${this.opts.readyNeedle}" after ${timeoutMs}ms`));
    }, timeoutMs);

    // Settling the readiness promise must never be fenced — an aborted or superseded
    // start() still has an awaiting caller. Only instance-field cleanup is fenced.
    child.on("exit", (code, signal) => {
      rls.forEach((rl) => rl.close());
      if (!seen) {
        failed(new Error(
          `${this.opts.name}: exited (code=${code} signal=${signal}) before ready. Last output:\n${this.recentLines(20).join("\n")}`,
        ));
      }
      if (this.child === child) {
        this.pid = null;
        this.child = null;
        if (this.state === "running") this.state = "failed";
      }
    });
    child.on("error", (e) => {
      rls.forEach((rl) => rl.close());
      failed(new Error(`${this.opts.name}: spawn error: ${e.message}`));
      if (this.child === child) {
        this.pid = null;
        this.child = null;
      }
    });

    try {
      await readiness;
      this.state = "running";
    } catch (e) {
      // stop() may have claimed the transition ("stopped") while we were starting — don't clobber it.
      if (this.state === "starting") this.state = "failed";
      if (this.child === child) {
        this.child = null;
        this.pid = null;
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    const child = this.child;
    const pid = this.pid;
    this.state = "stopped";
    if (!child) return;
    this.child = null;
    this.pid = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((res) => {
      child.once("exit", () => res());
      child.once("error", () => res());
    });
    // When detached, signal the whole process group (negative pid) so compute_ctl's orphaned
    // postgres child (R3: it never waits for/reparents-away its own child on SIGTERM) dies too,
    // instead of surviving as a PID-1 orphan. Wrapped in try/catch: a group that's already gone
    // (ESRCH) or a signal we're not permitted to send (EPERM, e.g. group leader already reaped)
    // must never make stop() itself throw — this method's contract is total.
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (this.opts.detached && pid) process.kill(-pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };
    signal("SIGTERM");
    const killer = setTimeout(() => signal("SIGKILL"), timeoutMs);
    await exited;
    clearTimeout(killer);
  }
}
