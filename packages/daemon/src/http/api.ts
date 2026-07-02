import Fastify, { type FastifyInstance } from "fastify";
import type { DevdbConfig } from "../config.js";
import type { StateDb } from "../state/db.js";
import type { EngineRuntime } from "../engine/boot.js";

export interface Deps {
  cfg: DevdbConfig;
  state: StateDb;
  engine: EngineRuntime;
}

export function buildServer(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/api/status", async () => {
    const engine = deps.engine.status();
    const healthy = Object.values(engine).every((p) => p.state === "running");
    return { version: "0.1.0", healthy, engine };
  });

  return app;
}
