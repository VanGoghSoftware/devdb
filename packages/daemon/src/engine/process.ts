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
    this.opts.onLine?.(line, stream);
  }

  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error(`${this.opts.name} already ${this.state}`);
    }
    this.state = "starting";
    const timeoutMs = this.opts.readyTimeoutMs ?? 60_000;
    const child = spawn(this.opts.bin, this.opts.args, {
      env: this.opts.env ?? {},
      cwd: this.opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.pid = child.pid ?? null;

    let ready: () => void;
    let failed: (e: Error) => void;
    const readiness = new Promise<void>((res, rej) => { ready = res; failed = rej; });

    let seen = false;
    const watch = (stream: NodeJS.ReadableStream, which: "stdout" | "stderr") => {
      const rl = readline.createInterface({ input: stream });
      rl.on("line", (line) => {
        this.ingest(line, which);
        if (!seen && line.includes(this.opts.readyNeedle)) {
          seen = true;
          ready();
        }
      });
    };
    watch(child.stdout!, "stdout");
    watch(child.stderr!, "stderr");

    const timer = setTimeout(() => {
      failed(new Error(`${this.opts.name}: timed out waiting for "${this.opts.readyNeedle}" after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("exit", (code, signal) => {
      this.pid = null;
      if (!seen) {
        failed(new Error(`${this.opts.name}: exited (code=${code} signal=${signal}) before ready. Last output:\n${this.recentLines(20).join("\n")}`));
      }
      if (this.state !== "stopped") this.state = seen && this.state === "running" ? "failed" : this.state;
      this.child = null;
    });
    child.on("error", (e) => failed(new Error(`${this.opts.name}: spawn error: ${e.message}`)));

    try {
      await readiness;
      this.state = "running";
    } catch (e) {
      this.state = "failed";
      child.kill("SIGKILL");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = "stopped";
      return;
    }
    this.state = "stopped";
    const exited = new Promise<void>((res) => child.once("exit", () => res()));
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    await exited;
    clearTimeout(killer);
    this.child = null;
    this.pid = null;
  }
}
