import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Deps } from "../http/api.js";
import { SessionStore } from "./session.js";
import { buildMcpServer } from "./server.js";

const SESSION_ID_HEADER = "mcp-session-id";
const IDLE_TTL_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

// Well-known loopback/container-gateway hostnames this daemon is legitimately reachable under.
// Matched on HOSTNAME ALONE (port-agnostic) — see the port-mapping note on isHostAllowed below —
// unlike cfg.mcpAllowedHosts/mcpAllowedOrigins, which are operator-supplied exact strings.
const TRUSTED_LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "host.docker.internal"]);

// DNS-rebinding guard (refinement spec Decision 1 + the Task-8 plan amendment): the SDK's own
// enableDnsRebindingProtection/allowedHosts/allowedOrigins transport options are @deprecated in
// the installed 1.29.0 (sdk-notes.md) in favor of "external middleware" — so the Host/Origin
// allowlist check below runs as a Fastify hook ahead of the route handler, not as transport
// config. A malicious page in the user's browser can't complete the DNS-rebinding attack (make
// the browser send a same-origin-looking request that actually reaches this loopback-bound
// daemon) if we reject any Host/Origin that isn't one of the names this daemon is legitimately
// reachable under.
//
// Host-header matching is HOSTNAME-ONLY for the well-known loopback names (port stripped before
// comparison), not exact "host:port" string matching. Reasoning: this daemon runs inside a
// container whose internal DEVDB_HTTP_PORT (4400) is not the port a real client ever connects
// through — docker-compose/testcontainers remap it to an arbitrary host port, so an exact-string
// allowlist built from cfg.httpPort would 403 every legitimate request that didn't happen to hit
// 4400 directly (confirmed against the SDK's OWN now-deprecated implementation, which does exact
// "host:port" string matching the same way and has the identical limitation — see
// webStandardStreamableHttp.js's `this._allowedHosts.includes(hostHeader)`). The security property
// DNS-rebinding protection actually needs is "does this hostname resolve to somewhere we trust",
// not "is this the exact port we happen to be configured for" — a port number carries no bearing
// on whether a request originated from a same-machine/same-docker-network caller vs. a remote
// attacker's rebound DNS name. cfg.mcpAllowedHosts/mcpAllowedOrigins remain exact-string matches
// (operator-supplied values, taken literally, may legitimately include a specific port to pin).
function isHostAllowed(host: string, cfg: Deps["cfg"]): boolean {
  const hostname = host.split(":")[0];
  if (hostname && TRUSTED_LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return cfg.mcpAllowedHosts.includes(host);
}

function isOriginAllowed(origin: string, cfg: Deps["cfg"]): boolean {
  if (cfg.mcpAllowedOrigins.length && cfg.mcpAllowedOrigins.includes(origin)) return true;
  try {
    const hostname = new URL(origin).hostname;
    return TRUSTED_LOOPBACK_HOSTNAMES.has(hostname);
  } catch {
    return false; // an Origin header that isn't a parseable URL is never legitimate
  }
}

// Registers the session-stateful Streamable-HTTP MCP endpoint at /mcp. Returns closeAll() so
// http/api.ts's preClose hook can drain every open MCP session within the daemon's shutdown
// budget, the same way the existing SSE preClose hook drains openSseResponses.
export function registerMcp(app: FastifyInstance, deps: Deps): { closeAll: () => Promise<void> } {
  const store = new SessionStore({ ttlMs: IDLE_TTL_MS });
  // unref() so this interval alone never keeps the process alive past shutdown — closeAll()
  // below still clearInterval()s it explicitly on the clean-shutdown path.
  const sweepTimer = setInterval(() => store.sweep(Date.now()), SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  // Host/Origin allowlist hook, scoped to /mcp only (registered directly on `app`, gated on
  // req.url, rather than inside a child-context .register() plugin) — this endpoint is the only
  // one on this Fastify instance carrying MCP's DNS-rebinding exposure (Streamable-HTTP is
  // reachable from a browser tab; every other REST route here is a plain fetch()/curl target
  // consumed by tooling, not a page-navigable endpoint the rebinding attack needs). A malformed
  // or absent Host header is impossible in practice (Node's HTTP parser requires it for HTTP/1.1),
  // but Origin is legitimately absent for same-origin non-browser clients (curl, the MCP SDK's
  // own client, server-to-server calls) — so Origin is checked only when present, matching the
  // brief's "reject with 403 when Host/Origin is present and not in the allowlist" wording.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/mcp")) return;
    const host = req.headers.host;
    if (host && !isHostAllowed(host, deps.cfg)) {
      return reply.status(403).send({ error: `Host ${JSON.stringify(host)} is not allowed — set DEVDB_MCP_ALLOWED_HOSTS to permit it` });
    }
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, deps.cfg)) {
      return reply.status(403).send({ error: `Origin ${JSON.stringify(origin)} is not allowed — set DEVDB_MCP_ALLOWED_ORIGINS to permit it` });
    }
  });

  function sessionIdOf(req: FastifyRequest): string | undefined {
    const raw = req.headers[SESSION_ID_HEADER];
    return typeof raw === "string" ? raw : undefined;
  }

  app.post("/mcp", async (req, reply) => {
    const sid = sessionIdOf(req);
    const existing = sid ? store.get(sid) : undefined;

    if (!existing) {
      if (!isInitializeRequest(req.body)) {
        return reply.status(400).send({ error: "no valid MCP session — send an initialize request first" });
      }

      // Build the McpServer BEFORE the transport: onsessioninitialized needs to close over both
      // already-constructed objects to store {transport, server} as one atomic session entry.
      // (The plan's original Step-8 draft declared `server` via `const` textually AFTER the
      // transport that referenced it in its own onsessioninitialized closure — a temporal-dead-
      // zone bug this ordering avoids.)
      const server = buildMcpServer(deps, () => server.server.getClientVersion());
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          store.set(id, { transport, server, lastSeen: Date.now() });
        },
      });
      // onclose is a post-construction property (not a ctor option — sdk-notes.md), fired when
      // the transport itself closes for any reason (client disconnect, error, or our own
      // store.delete()/closeAll() calling transport.close()). Idempotent: store.delete() no-ops
      // if the id is already gone (e.g. this firing as a side effect of a sweep-triggered close).
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) void store.delete(id);
      };

      await server.connect(transport);
      reply.hijack();
      await transport.handleRequest(req.raw, reply.raw, req.body);
      return;
    }

    store.touch(sid!, Date.now());
    reply.hijack();
    await existing.transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // GET (SSE stream for server-initiated notifications) and DELETE (explicit session teardown)
  // both require an existing session — the SDK library handles GET-vs-DELETE branching inside
  // handleRequest itself based on req.method, so this route pair just needs to resolve the
  // session and hand off the raw request/response.
  async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sid = sessionIdOf(req);
    const session = sid ? store.get(sid) : undefined;
    if (!session) {
      await reply.status(400).send({ error: "unknown or missing mcp-session-id" });
      return;
    }
    store.touch(sid!, Date.now());
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw);
  }
  app.get("/mcp", requireSession);
  app.delete("/mcp", requireSession);

  return {
    closeAll: async () => {
      clearInterval(sweepTimer);
      await store.closeAll();
    },
  };
}
