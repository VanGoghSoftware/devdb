import { execa } from "execa";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedProcess } from "./process.js";

// This wraps storcon_db, the storage controller's own metadata Postgres — not a compute. oracle:
// neon control_plane/src/storage_controller.rs → its initdb/createdb self-management (the closest
// neon analog of a component initdb'ing its own private Postgres); the actual initdb/postgres args
// and env below are DevDB's own.
// DevDB's own choice: the storcon_db superuser is `devdb` (neon_local's equivalent uses the host
// OS user via `whoami::username()`, not a fixed name — not directly comparable).
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

// A data dir's PG_VERSION is a plain-text file whose first token is the catalog major that initdb
// stamped it with (`17`, or a dev build's `19devel`). Parse the leading integer of that first token.
export function parsePgVersionFileMajor(content: string): number | null {
  const first = content.trim().split(/\s+/)[0] ?? "";
  const m = first.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

// `postgres --version` prints "postgres (PostgreSQL) 17.5" (true upstream), "... 19devel" (neon's
// vanilla dev build — what neond's vanilla_v17 actually is), or "... 17.5 (<fork-hash>)" (the neon
// fork). Take the major following "(PostgreSQL)"; fall back to the first integer anywhere.
export function parsePostgresVersionMajor(output: string): number | null {
  const tagged = output.match(/PostgreSQL\)\s+(\d+)/i);
  if (tagged) return Number(tagged[1]);
  const any = output.match(/(\d+)/);
  return any ? Number(any[1]) : null;
}

export class EmbeddedPostgres {
  private proc: ManagedProcess | null = null;
  private pgDir: string;
  private initInFlight: Promise<void> | null = null;
  private expectedMajorPromise: Promise<number | null> | null = null;

  constructor(private opts: {
    name: string; dataDir: string; pgInstallDir: string; port: number; password: string;
    onLine?: (line: string) => void;
    // Test seam (optional → boot.ts, the sole construction site, is unchanged): overrides how the
    // shipped storcon binary's catalog major is determined. Left unset in production, which probes
    // `<pgDir>/bin/postgres --version` once — see resolveExpectedMajor() below.
    probeBinaryMajor?: () => Promise<number>;
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

  // The catalog major of the storcon binary this image ships, resolved once (it is immutable for
  // the process lifetime). MEMOIZED on purpose: start()'s guard awaits it, and if two concurrent
  // start() calls ever awaited it they must share ONE suspension so they resume in registration
  // order — that is what keeps the running-guard→claim region atomic (see start()).
  private expectedBinaryMajor(): Promise<number | null> {
    this.expectedMajorPromise ??= this.resolveExpectedMajor();
    return this.expectedMajorPromise;
  }

  private async resolveExpectedMajor(): Promise<number | null> {
    try {
      if (this.opts.probeBinaryMajor) return await this.opts.probeBinaryMajor();
      const { stdout } = await execa(join(this.pgDir, "bin", "postgres"), ["--version"], {
        env: { LD_LIBRARY_PATH: join(this.pgDir, "lib") },
      });
      return parsePostgresVersionMajor(stdout);
    } catch (e) {
      // Fail OPEN: the guard's own inability to read the shipped binary's version must never block a
      // boot that would otherwise succeed. Only a CONFIRMED mismatch (both majors known and unequal)
      // refuses; postgres's own catalog check stays the backstop for anything that slips past.
      this.opts.onLine?.(
        `devdb: could not determine storcon postgres major (${(e as Error).message}); skipping catalog-major guard`,
      );
      return null;
    }
  }

  async start(): Promise<void> {
    // Catalog-major guard (initiative-A Phase 2). A pre-existing volume whose storcon catalog was
    // initdb'd by a DIFFERENT postgres major than the binary this image ships cannot be opened by
    // postgres — it FATAL-loops on a cryptic parameter/catalog error (observed live 2026-07-08 when
    // devdb:dev repointed to true-vanilla 17.5 over a neond-vanilla-19devel `/data`). Detect it and
    // refuse with an actionable message BEFORE spawning. Gated on PG_VERSION existing, so the
    // fresh-initdb path (boot.ts runs init() first → the file is stamped by THIS binary → majors
    // match) and any never-initialized dir fall straight through untouched.
    //
    // Placed BEFORE the running-guard on purpose: the expected-major probe is the one `await` in
    // start()'s pre-spawn section, and it must not land BETWEEN the running-guard and the
    // `this.proc` claim below — an await there would let two concurrent start()s both pass the guard
    // while `this.proc` is still null and race two postmasters (the invariant removeStalePidFile's
    // comment defends). Taking it up front, via the MEMOIZED expectedBinaryMajor(), means any
    // concurrent callers share ONE suspension and resume in registration order, so the first runs
    // the whole running-guard→claim region synchronously before the second re-checks. The
    // existsSync/readFileSync are synchronous, so when PG_VERSION is absent there is no await at all
    // and the pre-existing atomicity is byte-for-byte preserved.
    const pgVersionPath = join(this.opts.dataDir, "PG_VERSION");
    if (existsSync(pgVersionPath)) {
      const found = parsePgVersionFileMajor(readFileSync(pgVersionPath, "utf8"));
      if (found !== null) {
        const expected = await this.expectedBinaryMajor();
        if (expected !== null && found !== expected) {
          throw new Error(
            `${this.opts.name}: this volume's storage_controller catalog was created by PostgreSQL ${found}, ` +
            `but this image ships PostgreSQL ${expected}. PostgreSQL cannot open a data directory created by a ` +
            `different major version. Start DevDB with a fresh volume, or keep running the previous image; ` +
            `automated migration arrives with import/export (Phase 4).`,
          );
        }
      }
    }
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
