import { execa } from "execa";
import { existsSync, readdirSync, rmSync } from "node:fs";
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
    this.removeStalePidFile(); // synchronous by design — see the method's comment (atomic guard→claim)
    this.proc = new ManagedProcess({
      name: this.opts.name,
      bin: join(this.pgDir, "bin", "postgres"),
      // Deviation from oracle (postgres/mod.rs launches `-D <dir> -p <port>`, leaving the compiled
      // default socket dir /tmp): disable the unix socket entirely. storcon_db is reached ONLY over
      // TCP 127.0.0.1 (connectionUri() + the storage_controller's --database-url), so the socket is
      // dead weight — and it is a boot hazard. postgres writes `/tmp/.s.PGSQL.<port>.lock` recording
      // the SAME postmaster PID as postmaster.pid, and its stale-lock check FATALs on that file with
      // the identical live-PID heuristic. /tmp is the container writable layer (no tmpfs), so it
      // PERSISTS across every same-container restart (docker kill+start, OOM, host reboot, compose up
      // reusing the stopped container) — exactly the scenarios this fix targets. Removing only
      // postmaster.pid (below) would just relocate the boot FATAL onto this socket lock; disabling
      // the socket removes the whole file class permanently. (Compute sockets have the same exposure
      // — tracked separately; they are compute_ctl/ComputeSpec-configured, not launched here.)
      args: ["-D", this.opts.dataDir, "-p", String(this.opts.port), "-c", "unix_socket_directories="],
      env: { LD_LIBRARY_PATH: join(this.pgDir, "lib") },
      // oracle: readiness needle "connections" ("ready to accept connections")
      readyNeedle: "connections",
      onLine: (l) => this.opts.onLine?.(l),
    });
    await this.proc.start();
  }

  // An unclean container stop (docker kill / OOM / host reboot — anything that skips the SIGTERM
  // shutdown path, under which stop() below lets postgres exit cleanly and delete its own pid file)
  // leaves a stale postmaster.pid in the persistent data dir. On the next boot, container PID reuse
  // can make the dead postmaster's recorded PID look alive to postgres's stale-lock heuristic, so
  // postgres refuses to start at all ("lock file \"postmaster.pid\" already exists" → FATAL → the
  // daemon's boot fails). Left unfixed this is intermittent — a fresh data dir's initdb burns many
  // PIDs so the recorded PID often outlives the next (initdb-free) boot's range and postgres self-
  // heals, but once two consecutive boots both skip initdb the low recorded PID gets reused and the
  // FATAL bites (observed live 2026-07-04, after the sibling stale-/data/.lock guard was cleared).
  //
  // Remove it before launching: by this point the daemon has claimed the data dir via the
  // exclusive-create /data/.lock marker (index.ts creates it `wx` before EngineRuntime is even
  // constructed — a marker file, not a held fd), and the running-guard in start() rules out a live
  // child of THIS instance, so nothing can legitimately be using the data dir — a guarded unlink is
  // safe. Mirrors the crash-recovery cleanups DevDB already runs on boot for the .lock marker
  // (index.ts) and orphaned compute dirs (state/reconcile.ts sweepComputesDir). No oracle citation:
  // neon_local/the oracle never touches postmaster.pid anywhere, so there is no payload to port — a
  // plain unlink is the sanctioned fallback (AGENTS.md).
  //
  // This safety argument leans on start() being BOOT-ONLY: it is called once, from EngineRuntime
  // .start(), and a failed boot exits the process (there is no in-process restart path today). A
  // future crash-restart feature would have to re-derive safety — a crash-orphaned backend can still
  // hold shared memory, and postmaster.pid is postgres's OWN interlock for detecting that, so blindly
  // deleting it there could let a second postmaster corrupt shared state.
  //
  // SYNCHRONOUS on purpose: start()'s running-guard and its `this.proc = new ManagedProcess()` claim
  // must stay atomic. An `await` between them would let two concurrent start() calls both pass the
  // guard while `this.proc` is still null and then race two postmasters onto one data dir/port. A
  // sync unlink keeps the first real suspension point inside proc.start() (which has already set
  // "starting"), exactly as before this cleanup was added.
  private removeStalePidFile(): void {
    const pidFile = join(this.opts.dataDir, "postmaster.pid");
    if (!existsSync(pidFile)) return; // clean shutdowns delete it themselves — nothing to do
    rmSync(pidFile, { force: true });
    // Surface WHY a lock file just vanished — routed through the same onLine sink every storcon_db
    // line uses (→ docker logs via `[storcon_db] …` and LogsService's `daemon:storcon_db` channel).
    this.opts.onLine?.("devdb: removed a stale postmaster.pid from an unclean prior shutdown before start");
  }

  async stop(): Promise<void> {
    await this.proc?.stop();
    this.proc = null;
  }
}
