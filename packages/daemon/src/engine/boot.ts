import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { DevdbConfig } from "../config.js";
import type { StateDb } from "../state/db.js";
import type { LogsService } from "../services/logs.js";
import { ManagedProcess } from "./process.js";
import { EmbeddedPostgres } from "./embedded-postgres.js";
import { Tracer } from "./tracer.js";
import {
  brokerSpec, engineDirs, pageserverIdentityToml, pageserverMetadataJson,
  pageserverSpec, pageserverToml, safekeeperRegistrationBody, safekeeperSpec, storconSpec,
} from "./configs.js";

export class EngineRuntime {
  private storconDb: EmbeddedPostgres;
  private procs = new Map<string, ManagedProcess>();
  private tracer: Tracer;
  storconDbUri: string;

  constructor(
    private cfg: DevdbConfig,
    private state: StateDb,
    private logs: LogsService,
    // Task 3 (phase 3): announces "engine.status() may have changed" for ANY supervised component
    // (broker/storage_controller/safekeeper/pageserver) dying or restarting outside a service-
    // initiated write — index.ts forwards this to /api/events as an `engine.health` invalidation
    // hint. Deliberately optional/positional (matches ComputeManager's onStatusChange shape) so
    // boot.test.ts's existing 3-arg construction stays valid untouched.
    private onComponentStateChange?: (component: string, state: string) => void,
  ) {
    let pw = state.settings.get("storcon_db_password");
    if (!pw) {
      pw = randomBytes(24).toString("hex");
      state.settings.set("storcon_db_password", pw);
    }
    this.storconDb = new EmbeddedPostgres({
      name: "storcon_db",
      dataDir: engineDirs(cfg).storconDbDir,
      pgInstallDir: cfg.pgInstallDir,
      port: cfg.engine.storconDbPort,
      password: pw,
      // Route through LogsService (feeds SSE + recent() replay via `daemon:storcon_db`) while
      // KEEPING the stdout emission Task 8 established — `docker logs` must still carry every
      // supervised process's output unconditionally, LogsService is additive, not a replacement.
      onLine: (line) => {
        console.log(`[storcon_db] ${line}`);
        this.logs.ingest("daemon:storcon_db", line);
      },
    });
    this.storconDbUri = this.storconDb.connectionUri();

    // Catch-all sink on 127.0.0.1:4318 (DevDB's own — see engine/tracer.ts) — absorbs the
    // binaries' OTLP trace exports AND the storage_controller's --control-plane-url upcalls, both
    // of which target 4318. Constructed here, started first in start() / stopped last in stop().
    this.tracer = new Tracer(cfg.engine.tracerPort, (line) => {
      console.log(`[tracer] ${line}`);
      this.logs.ingest("daemon:tracer", line);
    });
  }

  private async launch(spec: { name: string; bin: string; args: string[]; readyNeedle: string }): Promise<void> {
    // onLine → stdout (docker logs) AND LogsService (SSE + recent() replay, `daemon:<name>`).
    // onStateChange → onComponentStateChange, if index.ts wired one in (Task 3, phase 3). Only
    // the four components launched through here get this hook — storcon_db/EmbeddedPostgres is
    // deliberately excluded (it never goes through launch()/ManagedProcess at all): its state only
    // changes during boot/shutdown, when no SSE client can be connected to observe it anyway;
    // GET /api/status (this class's status() below) remains the source of truth for it either way.
    const proc = new ManagedProcess({
      ...spec,
      readyTimeoutMs: 120_000,
      onLine: (line) => {
        console.log(`[${spec.name}] ${line}`);
        this.logs.ingest(`daemon:${spec.name}`, line);
      },
      onStateChange: (s) => this.onComponentStateChange?.(spec.name, s),
    });
    this.procs.set(spec.name, proc);
    await proc.start();
  }

  // oracle: neon control_plane/src/bin/neon_local.rs (handle_start_all_impl) + background_process.rs
  // (per-process spawn+wait-ready, ~10s poll). neon starts services CONCURRENTLY (JoinSet); DevDB's
  // fixed sequential order storcon_db → broker → storcon → safekeeper → pageserver is its own choice.
  async start(): Promise<void> {
    try {
      // First: the tracer sink, so it's listening before storcon/pageserver ever emit a trace or
      // control-plane upcall. Bind failure is NON-FATAL (like neon, which logs + drops the tracer
      // task): degrade to "no sink" — the 4318 noise resumes — rather than brick the daemon over a
      // telemetry port. The port is reserved in config (DEVDB_PORT_RANGE can't overlap it), so a
      // bind failure means something external holds 4318.
      await this.tracer.start().catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[tracer] sink failed to bind 127.0.0.1:${this.cfg.engine.tracerPort} — engine trace/upcall noise will resume: ${msg}`);
        this.logs.ingest("daemon:tracer", `sink failed to bind: ${msg}`);
      });

      const dirs = engineDirs(this.cfg);
      await Promise.all(Object.values(dirs).map((d) => mkdir(d, { recursive: true })));

      await this.storconDb.init();
      await this.storconDb.start();

      await this.launch(brokerSpec(this.cfg));
      await this.launch(storconSpec(this.cfg, this.storconDbUri));

      await this.launch(safekeeperSpec(this.cfg));
      await this.registerSafekeeper();

      await writeFile(join(dirs.pageserverDir, "identity.toml"), pageserverIdentityToml());
      await writeFile(join(dirs.pageserverDir, "pageserver.toml"), pageserverToml(this.cfg));
      await writeFile(join(dirs.pageserverDir, "metadata.json"), pageserverMetadataJson(this.cfg));
      await this.launch(pageserverSpec(this.cfg));
    } catch (e) {
      // Partial boot: stop() only tears down what actually started (ManagedProcess.stop()
      // no-ops on a null child; EmbeddedPostgres.stop() optional-chains), so it's safe to
      // call unconditionally here in reverse startup order.
      await this.stop().catch((stopErr) => {
        console.error("cleanup after failed boot also failed:", stopErr);
      });
      throw e;
    }
  }

  // oracle: neon control_plane/src/storage_controller.rs register_safekeepers / node_register (no bearer — trust mode)
  private async registerSafekeeper(): Promise<void> {
    const url = `http://127.0.0.1:${this.cfg.engine.storconPort}/control/v1/safekeeper/1`;
    const body = JSON.stringify(safekeeperRegistrationBody(this.cfg, new Date().toISOString()));
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return;
        lastError = new Error(`safekeeper registration failed: ${res.status} ${await res.text()}`);
        if (res.status >= 400 && res.status < 500) break; // non-transient
      } catch (e) {
        lastError = e;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    throw new Error(`safekeeper registration at ${url} failed after retries: ${String(lastError)}`);
  }

  // oracle: neon control_plane/src/bin/neon_local.rs try_stop_all (stop order); DevDB order:
  // pageserver → safekeeper → storage_controller → storage_broker → storcon_db → tracer.
  async stop(): Promise<void> {
    for (const name of ["pageserver", "safekeeper", "storage_controller", "storage_broker"]) {
      await this.procs.get(name)?.stop();
    }
    await this.storconDb.stop();
    await this.tracer.stop(); // last — absorbs any shutdown-time trace/upcall traffic; no-ops if unbound
  }

  status(): Record<string, { state: string; pid: number | null }> {
    const out: Record<string, { state: string; pid: number | null }> = {};
    // T16 rider (ledgered at Task 8): real EmbeddedPostgres state/pid, not a hardcoded "running".
    out.storcon_db = { state: this.storconDb.state, pid: this.storconDb.pid };
    for (const [name, proc] of this.procs) {
      out[name] = { state: proc.state, pid: proc.pid };
    }
    return out;
  }
}
