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
// unlike cfg.mcpAllowedHosts/mcpAllowedOrigins, which are operator-supplied exact strings compared
// as canonical hostnames (see canonicalHostname below).
//
// "::1" is listed in its BRACKETED form ("[::1]"). This differs from the Task-8 fix brief's
// working assumption ("IPv6 comes back bracket-stripped from URL") — empirically verified against
// the installed WHATWG URL implementation (Node v25.2.1): `new URL("http://[::1]:4400").hostname`
// returns "[::1]", brackets retained, not "::1". This is standardized WHATWG URL behavior (the
// spec defines `hostname` to stay round-trippable back into a URL, which for an IPv6 literal
// requires the brackets), not an implementation quirk — so the allowlist stores the bracketed
// form to match what the canonicalizer actually produces, rather than trusting the brief's
// unverified assumption.
const TRUSTED_LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]);

// Robustly extracts and canonicalizes a hostname from a raw HTTP authority string (a Host header's
// value, e.g. "localhost:4400" or "[::1]:4400" — NOT a full URL). Replaces the previous
// `host.split(":")[0]` parse, which mishandled IPv6 literals (splits on every colon inside the
// address) and let malformed authorities (join artifacts like "localhost, evil.com", or invalid
// ports like "localhost:bad") through uncaught. `new URL("http://" + authority)` is the standard
// robust way to parse a bare "host[:port]" authority: prefixing a scheme lets the WHATWG URL
// parser apply its own authority-parsing/validation (including IPv6 bracket handling) and reject
// anything that isn't a single valid host[:port] pair. Canonicalization: lowercase (case-
// insensitive hostname comparison) + strip a single trailing dot (a DNS FQDN's root-zone dot,
// "localhost." vs "localhost", refer to the same name). Returns null on ANY parse failure —
// callers must treat null as "reject", not "skip validation" (fail CLOSED, not fail open).
function canonicalHostname(authority: string): string | null {
  try {
    let hostname = new URL(`http://${authority}`).hostname.toLowerCase();
    if (hostname.length > 1 && hostname.endsWith(".")) hostname = hostname.slice(0, -1);
    return hostname || null;
  } catch {
    return null;
  }
}

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
// attacker's rebound DNS name. cfg.mcpAllowedHosts/mcpAllowedOrigins are operator-supplied values
// but are STILL compared as canonical hostnames (same canonicalHostname() call on both the
// request's authority and each configured entry) — not raw string equality — so an operator can
// write either "devdb.internal" or "devdb.internal:4400" in DEVDB_MCP_ALLOWED_HOSTS and either
// form still matches a request presenting the other.
function isHostAllowed(hostname: string, cfg: Deps["cfg"]): boolean {
  if (TRUSTED_LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return cfg.mcpAllowedHosts.some((entry) => canonicalHostname(entry) === hostname);
}

// Origin entries (both the request header and cfg.mcpAllowedOrigins) are FULL origin strings
// ("http://host:port"), unlike Host entries which are bare authorities ("host:port") — so this
// parses via `new URL(origin).hostname` directly (the string already carries a scheme), not
// canonicalHostname()'s scheme-prepending bare-authority parse. Still applies the same lowercase +
// trailing-dot canonicalization as canonicalHostname() so e.g. "http://LOCALHOST" and
// "http://localhost." both resolve to the same canonical "localhost".
function canonicalOriginHostname(origin: string): string | null {
  try {
    let hostname = new URL(origin).hostname.toLowerCase();
    if (hostname.length > 1 && hostname.endsWith(".")) hostname = hostname.slice(0, -1);
    return hostname || null;
  } catch {
    return null; // an Origin that isn't a parseable URL is never legitimate — reject, don't skip
  }
}

function isOriginAllowed(origin: string, cfg: Deps["cfg"]): boolean {
  const hostname = canonicalOriginHostname(origin);
  if (hostname === null) return false; // malformed Origin — fail closed
  if (TRUSTED_LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return cfg.mcpAllowedOrigins.some((entry) => canonicalOriginHostname(entry) === hostname);
}

// Scans req.raw.rawHeaders (the UN-collapsed wire-level header list — Node's parser preserves
// every repeated header line here, whereas req.headers.host would already be Node's own
// comma-joined/last-wins view for a header that legitimately appeared more than once) for how
// many times a given header name appears, case-insensitively (HTTP header names are case-
// insensitive). rawHeaders is a flat [name, value, name, value, ...] array — odd indices hold
// values, so only even indices (names) are compared. A count > 1 means the client (or a
// rebinding-adjacent proxy) sent the same security-relevant header twice; per Fix 1 that is
// ALWAYS ambiguous enough to reject outright rather than pick one value to validate.
function countRawHeader(rawHeaders: string[], name: string): number {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === name) count++;
  }
  return count;
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
  // consumed by tooling, not a page-navigable endpoint the rebinding attack needs).
  //
  // Route match is the EXACT pathname "/mcp" (query string, if any, stripped before comparing),
  // not a startsWith("/mcp") prefix — a prefix match would also catch a hypothetical future
  // "/mcpfoo" route that has nothing to do with this guard's threat model.
  //
  // Fix 1 — this hook now fails CLOSED on every ambiguous or malformed case, not just a
  // present-and-untrusted one:
  //   1. Missing/empty Host → 403. A same-origin browser request ALWAYS carries a Host header
  //      (Node's HTTP/1.1 parser requires one) — a request that arrives here with none is
  //      already suspicious, and the old `if (host && !allowed)` shape silently let it through
  //      (skipped the check entirely rather than rejecting), which is the fail-OPEN bug Fix 1
  //      closes. Falsy/absent Host is now treated identically to an unparseable one.
  //   2. Duplicate Host or duplicate Origin (checked against the UN-collapsed req.raw.rawHeaders,
  //      not the already-collapsed req.headers view) → 403. Two Host lines on the wire is never
  //      legitimate HTTP and is a classic header-smuggling/proxy-confusion shape — reject instead
  //      of validating whichever value Node's parser happened to keep.
  //   3. Malformed authority (canonicalHostname()/canonicalOriginHostname() return null — e.g.
  //      "localhost:bad", or a comma-joined join-artifact string) → 403.
  //   4. Origin is still optional (curl, the MCP SDK's own client, and other non-browser callers
  //      legitimately send none) — but a PRESENT Origin must resolve to an allowed hostname; it is
  //      no longer possible for a present-but-malformed Origin to slip through unchecked.
  app.addHook("onRequest", async (req, reply) => {
    const pathname = req.url.split("?")[0];
    if (pathname !== "/mcp") return;

    const rawHeaders = req.raw.rawHeaders;
    if (countRawHeader(rawHeaders, "host") > 1) {
      return reply.status(403).send({ error: "duplicate Host header is not allowed" });
    }
    if (countRawHeader(rawHeaders, "origin") > 1) {
      return reply.status(403).send({ error: "duplicate Origin header is not allowed" });
    }

    const host = req.headers.host;
    const hostname = host ? canonicalHostname(host) : null;
    if (hostname === null || !isHostAllowed(hostname, deps.cfg)) {
      return reply.status(403).send({ error: `Host ${JSON.stringify(host ?? null)} is not allowed — set DEVDB_MCP_ALLOWED_HOSTS to permit it` });
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
      // the transport itself closes for ANY reason — including a close WE initiated (store.
      // delete()/sweep()/closeAll() all call transport.close()). That "any reason" is exactly
      // why onclose must be PURE MAP REMOVAL and must never itself call transport.close() (Fix
      // 2): on the CLIENT-DISCONNECT path, the SDK closes the transport on its own → onclose
      // fires while the session-store entry is still present → if onclose called store.delete()
      // (which itself calls transport.close()), the transport would be closed a SECOND time.
      // removeEntry() is the pure-removal primitive (no close() call) that lets this callback
      // just drop the map entry; delete()/sweep()/closeAll() remain the sole owners of actually
      // calling transport.close(), on the paths WE initiate.
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) store.removeEntry(id);
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
