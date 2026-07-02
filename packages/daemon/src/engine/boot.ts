import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { DevdbConfig } from "../config.js";
import type { StateDb } from "../state/db.js";
import { ManagedProcess } from "./process.js";
import { EmbeddedPostgres } from "./embedded-postgres.js";
import {
  brokerSpec, engineDirs, pageserverIdentityToml, pageserverMetadataJson,
  pageserverSpec, pageserverToml, safekeeperRegistrationBody, safekeeperSpec, storconSpec,
} from "./configs.js";

export class EngineRuntime {
  private storconDb: EmbeddedPostgres;
  private procs = new Map<string, ManagedProcess>();
  storconDbUri: string;

  constructor(private cfg: DevdbConfig, private state: StateDb) {
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
      onLine: (line) => console.log(`[storcon_db] ${line}`),
    });
    this.storconDbUri = this.storconDb.connectionUri();
  }

  private async launch(spec: { name: string; bin: string; args: string[]; readyNeedle: string }): Promise<void> {
    // onLine → stdout so `docker logs` carries every supervised process's output.
    const proc = new ManagedProcess({
      ...spec,
      readyTimeoutMs: 120_000,
      onLine: (line) => console.log(`[${spec.name}] ${line}`),
    });
    this.procs.set(spec.name, proc);
    await proc.start();
  }

  // oracle: startup order src/daemon/mod.rs:182-232
  async start(): Promise<void> {
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
  }

  // oracle: src/daemon/mod.rs:247-281 (no bearer — trust mode)
  private async registerSafekeeper(): Promise<void> {
    const url = `http://127.0.0.1:${this.cfg.engine.storconPort}/control/v1/safekeeper/1`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(safekeeperRegistrationBody(this.cfg, new Date().toISOString())),
    });
    if (!res.ok) {
      throw new Error(`safekeeper registration failed: ${res.status} ${await res.text()}`);
    }
  }

  // oracle: shutdown order src/daemon/mod.rs:235-244
  async stop(): Promise<void> {
    for (const name of ["pageserver", "safekeeper", "storage_controller", "storage_broker"]) {
      await this.procs.get(name)?.stop();
    }
    await this.storconDb.stop();
  }

  status(): Record<string, { state: string; pid: number | null }> {
    const out: Record<string, { state: string; pid: number | null }> = {};
    out.storcon_db = { state: "running", pid: null };
    for (const [name, proc] of this.procs) {
      out[name] = { state: proc.state, pid: proc.pid };
    }
    return out;
  }
}
