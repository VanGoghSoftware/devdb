import { execFile } from "node:child_process";

// Parses `postgres (PostgreSQL) 16.9` and Debian-suffixed variants. Spawn (not shell) — the
// path came from OUR registry rows, but never interpolate paths into a shell string anyway.
export function detectPostgresVersion(pgbinPath: string): Promise<{ major: number; minor: number }> {
  return new Promise((resolve, reject) => {
    execFile(pgbinPath, ["--version"], { timeout: 10_000 }, (err, stdout) => {
      if (err) return reject(new Error(`${pgbinPath} --version failed: ${err.message}`));
      const m = /PostgreSQL\)\s+(\d+)\.(\d+)/.exec(stdout);
      if (!m) return reject(new Error(`unparseable postgres version output: ${stdout.trim().slice(0, 200)}`));
      resolve({ major: Number(m[1]), minor: Number(m[2]) });
    });
  });
}
