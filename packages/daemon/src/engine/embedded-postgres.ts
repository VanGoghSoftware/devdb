import { execa } from "execa";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
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

  constructor(private opts: {
    name: string; dataDir: string; pgInstallDir: string; port: number; password: string;
    onLine?: (line: string) => void;
  }) {
    this.pgDir = resolveVanillaPgDir(opts.pgInstallDir);
  }

  connectionUri(): string {
    return `postgresql://devdb:${this.opts.password}@127.0.0.1:${this.opts.port}/postgres`;
  }

  async init(): Promise<void> {
    if (existsSync(join(this.opts.dataDir, "PG_VERSION"))) return;
    await mkdir(this.opts.dataDir, { recursive: true });
    const pwfile = join(tmpdir(), `devdb-pw-${process.pid}-${this.opts.port}`);
    await writeFile(pwfile, this.opts.password, { mode: 0o600 });
    try {
      // oracle: initdb -U <user> --pwfile <f> --auth-local=scram-sha-256 --auth-host=scram-sha-256 -D <dir>
      await execa(join(this.pgDir, "bin", "initdb"), [
        "-U", "devdb", "--pwfile", pwfile,
        "--auth-local=scram-sha-256", "--auth-host=scram-sha-256",
        "-D", this.opts.dataDir,
      ], { env: { LD_LIBRARY_PATH: join(this.pgDir, "lib") } });
    } finally {
      await rm(pwfile, { force: true });
    }
  }

  async start(): Promise<void> {
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
