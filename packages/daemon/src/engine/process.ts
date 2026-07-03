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

  // Shared by stop() and start()'s own failure/timeout cleanup: when detached, signal the whole
  // process group (negative pid) instead of just the direct child, so a grandchild spawned before
  // a start failure (or before the group outlives SIGTERM in stop()) is group-killed rather than
  // left to whatever backstop the caller has (e.g. ComputeManager's reapOrphanedPostgres). Wrapped
  // in try/catch: a group/child that's already gone (ESRCH) or a signal we're not permitted to
  // send (EPERM) must never make the caller (stop()'s contract is total; start()'s catch must not
  // mask the original readiness/launch error) throw for this reason.
  private killSignal(child: ChildProcess, pid: number | null, sig: NodeJS.Signals): void {
    try {
      if (this.opts.detached && pid) process.kill(-pid, sig);
      else child.kill(sig);
    } catch {
      // already gone
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
        this.killSignal(child, child.pid ?? null, "SIGKILL");
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
    const signal = (sig: NodeJS.Signals) => this.killSignal(child, pid, sig);
    signal("SIGTERM");
    if (!this.opts.detached || !pid) {
      // Non-detached (engine binaries): unchanged from before this fix. The direct child IS the
      // only thing we're responsible for, so its own "exit" is the correct (and only) completion
      // signal, and the killer timer is scoped to exactly that child.
      const killer = setTimeout(() => signal("SIGKILL"), timeoutMs);
      await exited;
      clearTimeout(killer);
      return;
    }
    // Detached (compute_ctl): the LEADER exiting is not sufficient — compute_ctl orphans its
    // postgres child on SIGTERM instead of waiting for it (handover §4.4/§8.6), so the leader can
    // (and normally does) exit almost instantly while a group member it spawned is still alive,
    // possibly in Postgres "smart shutdown" (waits for clients) or otherwise ignoring SIGTERM
    // entirely. Awaiting only the leader's own exit — as the non-detached branch above does — and
    // clearing the SIGKILL timer right then would let that surviving member dodge the escalated
    // group SIGKILL forever (the bug this fix exists to close). So: observe the leader's own exit
    // (still needed — avoids leaving a dangling child ref, and the leader is usually first to
    // go), then poll the WHOLE GROUP for emptiness up to timeoutMs (from the SIGTERM send — a
    // SINGLE deadline covers both the leader-await below and the group-poll after it), escalating
    // to a group SIGKILL if anything in the group is still alive at the deadline.
    //
    // `await exited` here is ALSO bounded by that same deadline: the leader itself (not just a
    // grandchild) can ignore or never process SIGTERM (e.g. a wedged compute_ctl) — without a
    // bound, that would hang stop() forever, wedging the branch lane stop() runs under, and the
    // group-poll below (and its SIGKILL escalation) would never run at all. The killer timer is
    // armed BEFORE the leader-await so a hung leader is force-killed at the deadline; since the
    // leader is itself a member of the group, that SIGKILL reaches it too (SIGKILL is uncatchable),
    // so `exited` then resolves and control proceeds into the group-poll exactly as on the normal
    // path. On the common path (leader exits instantly on SIGTERM) the killer never fires and is
    // cleared immediately after `exited` resolves — behavior is byte-identical to before this bound
    // was added.
    const deadline = Date.now() + timeoutMs;
    const killer = setTimeout(() => signal("SIGKILL"), timeoutMs);
    await exited;
    clearTimeout(killer);
    const groupGone = () => {
      try {
        process.kill(-pid, 0);
        return false; // signal 0 succeeded — at least one process in the group still exists
      } catch {
        return true; // ESRCH (or EPERM on an unrelated already-reaped pid) — treat as gone
      }
    };
    while (!groupGone() && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
    }
    if (!groupGone()) {
      signal("SIGKILL");
      // Brief bounded confirmation window — mirrors ComputeManager.reapOnePid's own post-SIGKILL
      // poll (manager.ts). Not indefinite: stop()'s contract is to resolve, not to guarantee the
      // kernel has fully reaped the group by the time it returns.
      const killDeadline = Date.now() + 1000;
      while (!groupGone() && Date.now() < killDeadline) {
        await new Promise((res) => setTimeout(res, 50));
      }
    }
  }
}
