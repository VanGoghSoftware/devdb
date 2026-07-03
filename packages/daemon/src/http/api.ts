import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import { PgVersionSchema } from "@devdb/shared";
import type { DevdbConfig } from "../config.js";
import type { StateDb } from "../state/db.js";
import type { EngineRuntime } from "../engine/boot.js";
import type { ProjectsService } from "../services/projects.js";
import type { BranchesService } from "../services/branches.js";
import type { EndpointsService } from "../services/endpoints.js";
import type { TimeTravelService } from "../services/timetravel.js";
import type { LogsService } from "../services/logs.js";
import type { SqlService } from "../services/sql.js";
import { DevdbError } from "../services/errors.js";
import { toBranchDto, toProjectDto } from "../services/dto.js";

// T16 rider (ledgered at Task 12, optional): /api/status's top-level "version" comes from this
// package's own package.json instead of a hand-maintained literal. Read once at module load —
// resolves relative to THIS file both in dev (src/http/api.ts -> ../../package.json) and in the
// built image (dist/http/api.js -> ../../package.json), since both sit exactly two directories
// under the package root (src/http/ and dist/http/ mirror each other — rootDir:"src",
// outDir:"dist"). A read failure here would be a packaging bug worth surfacing loudly rather
// than papering over with a silent fallback string.
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string }
).version;

export interface Deps {
  cfg: DevdbConfig;
  state: StateDb;
  engine: EngineRuntime;
  logs: LogsService;
  services: {
    projects: ProjectsService; branches: BranchesService; endpoints: EndpointsService;
    timetravel: TimeTravelService; sql: SqlService;
  };
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
    return { version: PACKAGE_VERSION, healthy, engine };
  });

  // Open SSE responses, tracked so preClose (below) can end them explicitly. Fastify's own docs
  // for both `close()`'s shutdown lifecycle and the `preClose` hook call this out by name: an
  // SSE stream is (from the HTTP server's point of view) a request that never completes, so
  // `server.close()` — which "waits for all in-flight requests to complete" — would otherwise
  // hang for as long as any client stays connected, silently eating this daemon's 45s hard-exit
  // budget in index.ts's shutdown() before engine/computes ever get torn down.
  const openSseResponses = new Set<FastifyReply["raw"]>();
  app.addHook("preClose", async () => {
    for (const raw of openSseResponses) raw.end();
  });

  // Replays recent() (bounded ring, oldest-first) as one SSE event per line, then subscribes for
  // the live tail. reply.hijack() is Fastify's documented mechanism for handing a reply fully
  // over to raw Node writes (see Reply.md's .hijack() section): without it, this being an async
  // route handler means Fastify calls reply.send() on whatever the handler eventually returns
  // once its promise settles — which would race/conflict with the raw writes already in flight
  // on the same socket. Unsubscribes AND drops the openSseResponses entry on the underlying
  // response socket's "close" — fires on an explicit client disconnect, a dropped connection, or
  // reply.raw.end() (including the preClose hook's own end() call above) — so a client that
  // simply stops reading (tab closed, curl killed) doesn't leak a subscriber callback inside
  // LogsService forever, and a long-disconnected client doesn't linger in this Set either.
  //
  // flushHeaders() is load-bearing, not defensive: verified empirically (Node's http.
  // ServerResponse can leave writeHead()'s headers sitting in its internal buffer until the
  // first body write() or end()) that a channel with nothing yet in recent() — no backlog
  // write() follows writeHead() — leaves the client's fetch()/EventSource hanging with headers
  // never observed as sent, until the FIRST live line arrives (which may be never, for a daemon
  // component that hasn't logged anything yet, or a freshly-started compute). Every client must
  // see its 200 + headers immediately on connect regardless of whether there's backlog to replay.
  // Fix 2 (review): backpressure + write-safety hardening. Node's http.ServerResponse.write()
  // returns `false` when the socket's internal buffer is over its highWaterMark — this is the
  // documented signal that the client (or its network path) is reading slower than this server is
  // producing lines. Buffering unboundedly in that case (the pre-fix code did: every write() call
  // site ignored the return value) would let one slow SSE client's kernel/user-space write buffer
  // grow forever for as long as ingest() keeps producing lines, an unbounded per-connection memory
  // leak with no cap. The policy adopted here is intentionally simple and bounded: on the FIRST
  // slow-write signal (or a write that throws, or a write attempted against an already-
  // ended/destroyed socket), tear the connection down and unsubscribe — never buffer past that
  // point. The client's EventSource/fetch reconnects on its own (SSE's standard behavior) and
  // replays via recent() from the top, so no lines are silently lost forever — just re-delivered
  // on the next connection, which is a far safer failure mode than an unbounded write buffer.
  function sse(reply: FastifyReply, channel: string): void {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.flushHeaders();

    // A write against a socket that's already erroring (e.g. an ECONNRESET from a client that
    // vanished mid-write) would otherwise surface as an uncaught "error" event on reply.raw and
    // crash the process — Node's EventEmitter contract treats an "error" event with zero
    // listeners as fatal. This handler exists solely to prevent that; the actual teardown for a
    // dead connection happens through safeWrite()'s own destroyed/writableEnded check and the
    // "close" handler below, not through this listener's body.
    reply.raw.on("error", () => {});

    // Mutable + assigned a real no-op up front (rather than left as a `const` declared only after
    // the replay loop below) so that safeWrite() failing on the very FIRST replayed line — before
    // logs.subscribe() ever runs — can still call teardown() safely instead of throwing a
    // temporal-dead-zone ReferenceError. Reassigned to the real unsubscribe closure once
    // logs.subscribe() is actually called, further down.
    let unsub: () => void = () => {};

    // teardown() is idempotent-safe to call more than once (write failures can cascade across
    // the replay loop and a live callback firing in the same tick) — end()/unsub() on an
    // already-ended/unsubscribed reply.raw is harmless, and deleting from openSseResponses twice
    // is a no-op Set.delete().
    function teardown(): void {
      unsub();
      openSseResponses.delete(reply.raw);
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
    }

    // Returns false (and tears the connection down) if the write did not go through — either
    // because the socket was already gone, the write threw, or Node's own backpressure signal
    // fired. Every call site (replay loop below, and the live subscribe() callback) must check
    // this return value and stop writing further lines once it's false — the socket is being
    // torn down and any subsequent write would either throw or buffer onto a dead connection.
    function safeWrite(line: string): boolean {
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        teardown();
        return false;
      }
      try {
        const ok = reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
        if (!ok) {
          // Slow client (backpressure) — bounded policy: drop the connection rather than buffer
          // unboundedly. The client's own reconnect + recent()-replay makes this a safe drop.
          teardown();
          return false;
        }
        return true;
      } catch {
        // A write against a socket mid-teardown (e.g. a race between this write and the
        // "close" event firing) must never crash log ingestion for other subscribers on this
        // channel — same swallow contract as LogsService.ingest's per-subscriber try/catch.
        teardown();
        return false;
      }
    }

    let replayFailed = false;
    for (const line of deps.logs.recent(channel)) {
      // Abort the replay loop on the first failed write — teardown() has already unsubscribed
      // and ended the response, so continuing to iterate would just call write() again against
      // an already-ended socket for no benefit.
      if (!safeWrite(line)) { replayFailed = true; break; }
    }

    // If the replay loop above already tore this connection down (dead socket, or backpressure
    // on the very first replayed line), skip subscribing entirely — there is nothing live left to
    // feed, and registering a subscriber here just to have its very next callback immediately
    // hit safeWrite()'s writableEnded/destroyed check and call teardown() again would be pure
    // waste (and a — harmless but pointless — brief live entry in LogsService's subscriber Set).
    if (replayFailed) return;

    unsub = deps.logs.subscribe(channel, (line) => {
      safeWrite(line);
    });
    openSseResponses.add(reply.raw);
    reply.raw.on("close", () => {
      unsub();
      openSseResponses.delete(reply.raw);
    });
  }

  // Fix 3 (review): allowlist the exact set of components EngineRuntime ever ingests under a
  // `daemon:<component>` channel (see engine/boot.ts and engine/configs.ts's *Spec() functions'
  // `name` fields) — storcon_db (embedded postgres), the four ManagedProcess-supervised engine
  // components. Before this, any string in the :component path param opened an SSE stream (200,
  // headers flushed, indefinite hang) against a channel LogsService had never heard of and never
  // would — an unauthenticated way to hold open arbitrarily many never-closing connections against
  // this daemon by hitting distinct nonsense component names, each backed by nothing.
  const DAEMON_LOG_COMPONENTS = new Set([
    "storcon_db", "storage_broker", "storage_controller", "safekeeper", "pageserver",
  ]);
  app.get("/api/daemon/logs/:component", async (req, reply) => {
    const { component } = req.params as { component: string };
    if (!DAEMON_LOG_COMPONENTS.has(component)) {
      throw new DevdbError(404, `unknown daemon component: ${JSON.stringify(component)}`);
    }
    sse(reply, `daemon:${component}`);
  });

  const CreateProject = z.object({ name: z.string(), pgVersion: PgVersionSchema.optional() });
  app.post("/api/projects", async (req, reply) => {
    const body = CreateProject.parse(req.body);
    const out = await deps.services.projects.create(body);
    return reply.status(201).send({
      project: toProjectDto(out.project),
      mainBranch: toBranchDto(await deps.services.branches.detail(out.mainBranch)),
    });
  });
  app.get("/api/projects", async () => deps.services.projects.list().map(toProjectDto));
  app.get("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    return toProjectDto(deps.services.projects.byIdOr404(id));
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
    return reply.status(201).send(toBranchDto(await deps.services.branches.detail(branch)));
  });
  app.get("/api/projects/:id/branches", async (req) => {
    const { id } = req.params as { id: string };
    deps.services.projects.byIdOr404(id);
    return (await deps.services.branches.list(id)).map(toBranchDto);
  });
  app.get("/api/branches/:id", async (req) => {
    const { id } = req.params as { id: string };
    return toBranchDto(await deps.services.branches.detail(deps.services.branches.byIdOr404(id)));
  });
  app.delete("/api/branches/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await deps.services.branches.delete(id);
    return reply.status(204).send();
  });

  app.post("/api/branches/:id/endpoint/start", async (req) => {
    const { id } = req.params as { id: string };
    return toBranchDto(await deps.services.endpoints.start(id));
  });
  app.post("/api/branches/:id/endpoint/stop", async (req) => {
    const { id } = req.params as { id: string };
    return toBranchDto(await deps.services.endpoints.stop(id));
  });
  app.get("/api/branches/:id/endpoint", async (req) => {
    const { id } = req.params as { id: string };
    const detail = await deps.services.branches.detail(deps.services.branches.byIdOr404(id));
    return { status: detail.endpointStatus, port: detail.port };
  });
  app.get("/api/branches/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    deps.services.branches.byIdOr404(id);
    sse(reply, `branch:${id}:compute`);
  });

  app.get("/api/branches/:id/lsn", async (req) => {
    const { id } = req.params as { id: string };
    const { timestamp } = req.query as { timestamp?: string };
    if (!timestamp) throw new DevdbError(400, "timestamp query parameter required");
    return { lsn: await deps.services.timetravel.lsnAtTimestamp(id, timestamp) };
  });

  const Restore = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("in_place"), to: z.string() }),
    z.object({ mode: z.literal("new_branch"), to: z.string(), name: z.string() }),
  ]);
  app.post("/api/branches/:id/restore", async (req) => {
    const { id } = req.params as { id: string };
    const body = Restore.parse(req.body);
    if (body.mode === "in_place") {
      return toBranchDto(await deps.services.timetravel.restoreInPlace(id, body.to));
    }
    const src = deps.services.branches.byIdOr404(id);
    const b = await deps.services.timetravel.branchAtTimestamp({
      projectId: src.projectId, sourceBranchId: id, name: body.name,
      isoTimestamp: body.to, createdBy: "api",
    });
    return toBranchDto(await deps.services.branches.detail(b));
  });

  app.post("/api/branches/:id/reset", async (req) => {
    const { id } = req.params as { id: string };
    return toBranchDto(await deps.services.timetravel.resetToParent(id));
  });

  // The SQL console executes arbitrary SQL as the postgres SUPERUSER on the branch's endpoint —
  // that is the product intent (spec Sec.Auth's localhost trust model), not an oversight: phase 1
  // has no auth gating anywhere in front of this daemon's REST API, and this route is not a
  // special case carved out from that posture.
  const SqlBody = z.object({ branchId: z.string(), query: z.string() });
  app.post("/api/sql", async (req) => {
    const body = SqlBody.parse(req.body);
    return deps.services.sql.run(body.branchId, body.query);
  });

  return app;
}
