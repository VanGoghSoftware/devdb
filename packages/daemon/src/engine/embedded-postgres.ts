import { execa } from "execa";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedProcess } from "./process.js";

// oracle: src/daemon/postgres/mod.rs — initdb/postgres args and env.
// Deviation: user is `devdb` (neond uses `neond`).
export function resolveVanillaPgDir(pgInstallDir: string): string {
  const vanilla = join(pgInstallDir, "vanilla_v17");
  if (existsSync(vanilla)) return vanilla;
  const versions = readdirSync(pgInstallDir)
    .filter((d) => /^v\d+$/.test(d))
    .map((d) => Number(d.slice(1)))
    .sort((a, b) => b - a);
  if (versions.length === 0) throw new Error(`no postgres install found in ${pgInstallDir}`);
  return join(pgInstallDir, `v${versions[0]}`);
}

export class EmbeddedPostgres {
  private proc: ManagedProcess | null = null;
  private pgDir: string;
  private initInFlight: Promise<void> | null = null;

  constructor(private opts: {
    name: string; dataDir: string; pgInstallDir: string; port: number; password: string;
    onLine?: (line: string) => void;
  }) {
    this.pgDir = resolveVanillaPgDir(opts.pgInstallDir);
  }

  connectionUri(): string {
    return `postgresql://devdb:${encodeURIComponent(this.opts.password)}@127.0.0.1:${this.opts.port}/postgres`;
  }

  // T16 rider (ledgered at Task 8 — see task-8-report.md's follow-up #1): surfaces the real
  // ManagedProcess state instead of EngineRuntime.status() hardcoding storcon_db as "running".
  // No `this.proc` yet (never started) or after stop() (nulled out) reads as "stopped", matching
  // the same idle/never-started semantic ManagedProcess itself uses before its first start().
  get state(): "stopped" | "starting" | "running" | "failed" {
    return this.proc?.state ?? "stopped";
  }

  // Companion to `state` above — same rider, same report follow-up (its wording covered both
  // the hardcoded "running" state and the hardcoded-null pid). Free to expose since ManagedProcess
  // already tracks it; closes the gap fully rather than leaving pid stuck at null.
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  init(): Promise<void> {
    this.initInFlight ??= this.doInit().finally(() => {
      this.initInFlight = null;
    });
    return this.initInFlight;
  }

  private async doInit(): Promise<void> {
    if (existsSync(join(this.opts.dataDir, "PG_VERSION"))) return;
    await mkdir(this.opts.dataDir, { recursive: true });
    // No PG_VERSION but non-empty = an interrupted init; initdb refuses non-empty dirs, so clear it.
    for (const entry of await readdir(this.opts.dataDir)) {
      await rm(join(this.opts.dataDir, entry), { recursive: true, force: true });
    }
    const pwDir = await mkdtemp(join(tmpdir(), "devdb-pw-"));
    const pwfile = join(pwDir, "pw");
    try {
      await writeFile(pwfile, this.opts.password, { mode: 0o600, flag: "wx" });
      // oracle: initdb -U <user> --pwfile <f> --auth-local=scram-sha-256 --auth-host=scram-sha-256 -D <dir>
      await execa(join(this.pgDir, "bin", "initdb"), [
        "-U", "devdb", "--pwfile", pwfile,
        "--auth-local=scram-sha-256", "--auth-host=scram-sha-256",
        "-D", this.opts.dataDir,
      ], { env: { LD_LIBRARY_PATH: join(this.pgDir, "lib") } });
    } finally {
      await rm(pwDir, { recursive: true, force: true });
    }
  }

  async start(): Promise<void> {
    if (this.proc && (this.proc.state === "running" || this.proc.state === "starting")) {
      throw new Error(`${this.opts.name} already ${this.proc.state}`);
    }
    this.proc = new ManagedProcess({
      name: this.opts.name,
      bin: join(this.pgDir, "bin", "postgres"),
      args: ["-D", this.opts.dataDir, "-p", String(this.opts.port)],
      env: { LD_LIBRARY_PATH: join(this.pgDir, "lib") },
      // oracle: readiness needle "connections" ("ready to accept connections")
      readyNeedle: "connections",
      onLine: (l) => this.opts.onLine?.(l),
    });
    await this.proc.start();
  }

  async stop(): Promise<void> {
    await this.proc?.stop();
    this.proc = null;
  }
}
