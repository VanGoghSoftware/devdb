import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { DevdbConfig } from "../config.js";

// Serves the built SPA and owns the SPA fallback. Registered LAST in buildServer so every real
// route (REST, MCP, SSE) keeps priority. Fallback policy (spec Decision 4 / global constraint):
//   - /api/* and /mcp* NEVER fall back to index.html — unknown API paths stay JSON 404s;
//   - only GET/HEAD navigations fall back (a POST to an unknown path is a 404, not the app);
//   - everything else (e.g. /projects/<id> deep links) gets index.html and the router takes over.
// @fastify/static's wildcard GET/HEAD route serves real files and calls the app's not-found
// handler on a miss — which is exactly where the policy below lives.
export function registerWebUi(app: FastifyInstance, cfg: DevdbConfig): void {
  if (!cfg.webDistDir) return;
  if (!existsSync(cfg.webDistDir)) {
    app.log.warn(`DEVDB_WEB_DIST=${cfg.webDistDir} does not exist — web UI will not be served`);
    return;
  }
  void app.register(fastifyStatic, { root: cfg.webDistDir });
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? "/";
    const isApiSurface = url.startsWith("/api/") || url === "/api" || url.startsWith("/mcp");
    const isNavigation = req.raw.method === "GET" || req.raw.method === "HEAD";
    if (isApiSurface || !isNavigation) {
      return reply.status(404).send({ error: `route ${req.raw.method} ${url} not found` });
    }
    return reply.sendFile("index.html");
  });
}
