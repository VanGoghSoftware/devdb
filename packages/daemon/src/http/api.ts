import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { PgVersionSchema } from "@devdb/shared";
import type { DevdbConfig } from "../config.js";
import type { StateDb } from "../state/db.js";
import type { EngineRuntime } from "../engine/boot.js";
import type { ProjectsService } from "../services/projects.js";
import { DevdbError } from "../services/errors.js";

export interface Deps {
  cfg: DevdbConfig;
  state: StateDb;
  engine: EngineRuntime;
  services: { projects: ProjectsService };
}

export function buildServer(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DevdbError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    app.log.error(err);
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: message });
  });

  app.get("/api/status", async () => {
    const engine = deps.engine.status();
    const healthy = Object.values(engine).every((p) => p.state === "running");
    return { version: "0.1.0", healthy, engine };
  });

  const CreateProject = z.object({ name: z.string(), pgVersion: PgVersionSchema.optional() });
  app.post("/api/projects", async (req, reply) => {
    const body = CreateProject.parse(req.body);
    const out = await deps.services.projects.create(body);
    return reply.status(201).send(out);
  });
  app.get("/api/projects", async () => deps.services.projects.list());
  app.get("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    return deps.services.projects.byIdOr404(id);
  });
  app.delete("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await deps.services.projects.delete(id);
    return reply.status(204).send();
  });

  return app;
}
