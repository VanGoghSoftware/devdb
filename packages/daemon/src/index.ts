import { open } from "node:fs/promises";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openState } from "./state/db.js";
import { EngineRuntime } from "./engine/boot.js";
import { buildServer } from "./http/api.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true });

  // oracle: src/daemon/lease/mod.rs — exclusive-create lockfile
  const lockPath = join(cfg.dataDir, ".lock");
  try {
    const fh = await open(lockPath, "wx");
    await fh.close();
  } catch {
    console.error(`lockfile ${lockPath} exists — another devdb owns this data dir, or it crashed. Remove the file if you are sure no other instance runs.`);
    process.exit(1);
  }

  const state = openState(join(cfg.dataDir, "state.db"));
  const engine = new EngineRuntime(cfg, state);
  await engine.start();

  const app = buildServer({ cfg, state, engine });
  await app.listen({ host: "0.0.0.0", port: cfg.httpPort });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await engine.stop();
    const { rm } = await import("node:fs/promises");
    await rm(lockPath, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
