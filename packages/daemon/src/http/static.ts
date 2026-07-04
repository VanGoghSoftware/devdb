import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { DevdbConfig } from "../config.js";

// Normalizes a raw request URL to a decoded pathname: strips the query string, then
// percent-decodes. MUST be applied before any prefix test on a raw URL — otherwise a query
// string (`/api?x=1`) or percent-encoding (`/%61pi/nope`, `/m%63p/deep`) trivially defeats a
// naive `=== "/api"` check. Malformed percent-encoding falls back to the query-stripped raw
// value rather than throwing, so a garbage sequence degrades to "not reserved"/"not an asset"
// instead of 500ing the request.
function decodedPathname(rawUrl: string): string {
  const stripped = rawUrl.split("?")[0] ?? "/";
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

// Tests a decoded pathname against the reserved /api and /mcp surfaces — these NEVER fall back
// to index.html; unknown API paths stay JSON 404s (spec Decision 4).
function reservedApiOrMcp(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/mcp" || pathname.startsWith("/mcp");
}

// A path is an "asset" (has a file extension) when its last segment matches /\.[^/]+$/ — e.g.
// /assets/app.js, /favicon.ico. SPA app routes (/, /projects/<id>, /settings) are extensionless.
function hasFileExtension(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return /\.[^/]+$/.test(lastSegment);
}

// Serves the built SPA and owns the SPA fallback. Registered LAST in buildServer so every real
// route (REST, MCP, SSE) keeps priority. Fallback policy (spec Decision 4 / global constraint):
//   - /api/* and /mcp* NEVER fall back to index.html — unknown API paths stay JSON 404s;
//   - only GET/HEAD navigations fall back (a POST to an unknown path is a 404, not the app);
//   - only EXTENSIONLESS navigations fall back — a missing asset (e.g. a stale /assets/x.js
//     reference from a broken build) 404s for real instead of silently returning 200 HTML that
//     the browser then fails to parse as JS;
//   - everything else (e.g. /projects/<id> deep links) gets index.html and the router takes over.
// @fastify/static's wildcard GET/HEAD route serves real files and calls the app's not-found
// handler on a miss — which is exactly where the policy below lives.
export function registerWebUi(app: FastifyInstance, cfg: DevdbConfig): void {
  if (!cfg.webDistDir) return;
  if (!existsSync(cfg.webDistDir)) {
    app.log.warn(`DEVDB_WEB_DIST=${cfg.webDistDir} does not exist — web UI will not be served`);
    return;
  }
  void app.register(fastifyStatic, {
    root: cfg.webDistDir,
    // Belt-and-suspenders alongside the notFoundHandler check below: even if a file somehow
    // existed in dist at a reserved path (e.g. dist/api/nope), the static plugin itself must
    // never serve it — allowedPath is consulted before every real-file send, not just on a miss.
    // @fastify/static v9 passes `pathname` already query-stripped but still percent-encoded, so
    // this still needs the decode step inside reservedApiOrMcp/decodedPathname.
    allowedPath: (pathname) => !reservedApiOrMcp(decodedPathname(pathname)),
    // v9 defaults to "allow"; hidden files under a (possibly mispointed) DEVDB_WEB_DIST must
    // never be served.
    dotfiles: "ignore",
  });
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? "/";
    const method = req.raw.method;
    const isNavigation = method === "GET" || method === "HEAD";
    const pathname = decodedPathname(url);
    if (!isNavigation || reservedApiOrMcp(pathname)) {
      return reply.status(404).send({ error: `route ${method} ${url} not found` });
    }
    if (hasFileExtension(pathname)) {
      return reply.status(404).send({ error: `route ${method} ${url} not found` });
    }
    return reply.sendFile("index.html");
  });
}
