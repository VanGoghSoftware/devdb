import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { PgVersionSchema } from "@devdb/shared";
import type { DevdbConfig } from "../config.js";
import type { StateDb } from "../state/db.js";
import type { EngineRuntime } from "../engine/boot.js";
import type { ProjectsService } from "../services/projects.js";
import type { BranchesService } from "../services/branches.js";
import type { EndpointsService } from "../services/endpoints.js";
import { DevdbError } from "../services/errors.js";

export interface Deps {
  cfg: DevdbConfig;
  state: StateDb;
  engine: EngineRuntime;
  services: { projects: ProjectsService; branches: BranchesService; endpoints: EndpointsService };
}

export function buildServer(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: "invalid request body",
        issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    if (err instanceof DevdbError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    app.log.error(err);
    const message = err instanceof Error ? err.message : String(err);
    const rawStatusCode = (err as { statusCode?: unknown }).statusCode;
    const sc = typeof rawStatusCode === "number" && rawStatusCode >= 400 && rawStatusCode < 600
      ? rawStatusCode
      : 500;
    return reply.status(sc).send({ error: message });
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

  const CreateBranch = z.object({
    name: z.string(),
    parentBranchId: z.string().optional(),
    atLsn: z.string().optional(),
  });
  app.post("/api/projects/:id/branches", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateBranch.parse(req.body);
    const branch = await deps.services.branches.create({ projectId: id, ...body, createdBy: "api" });
    return reply.status(201).send(await deps.services.branches.detail(branch));
  });
  app.get("/api/projects/:id/branches", async (req) => {
    const { id } = req.params as { id: string };
    deps.services.projects.byIdOr404(id);
    return deps.services.branches.list(id);
  });
  app.get("/api/branches/:id", async (req) => {
    const { id } = req.params as { id: string };
    return deps.services.branches.detail(deps.services.branches.byIdOr404(id));
  });
  app.delete("/api/branches/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await deps.services.branches.delete(id);
    return reply.status(204).send();
  });

  app.post("/api/branches/:id/endpoint/start", async (req) => {
    const { id } = req.params as { id: string };
    return deps.services.endpoints.start(id);
  });
  app.post("/api/branches/:id/endpoint/stop", async (req) => {
    const { id } = req.params as { id: string };
    return deps.services.endpoints.stop(id);
  });
  app.get("/api/branches/:id/endpoint", async (req) => {
    const { id } = req.params as { id: string };
    const detail = await deps.services.branches.detail(deps.services.branches.byIdOr404(id));
    return { status: detail.endpointStatus, port: detail.port };
  });

  return app;
}
