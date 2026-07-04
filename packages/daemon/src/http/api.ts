import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import { PgVersionSchema, BranchContextSchema, type PgMajorStatusDto } from "@devdb/shared";
import type { DevdbConfig } from "../config.js";
import type { StateDb } from "../state/db.js";
import type { EngineRuntime } from "../engine/boot.js";
import type { ProjectsService } from "../services/projects.js";
import type { BranchesService } from "../services/branches.js";
import type { EndpointsService } from "../services/endpoints.js";
import type { TimeTravelService } from "../services/timetravel.js";
import type { LogsService } from "../services/logs.js";
import type { EventsService } from "../services/events.js";
import type { SqlService } from "../services/sql.js";
import type { Logger } from "../logging/logger.js";
import type { BuildRegistry } from "../compute/builds/registry.js";
import type { Provisioner } from "../compute/builds/provisioner.js";
import type { ComputesApi } from "../services/engine-api.js";
import { DevdbError } from "../services/errors.js";
import { toBranchDto, toPgBuildDto, toProjectDto } from "../services/dto.js";
import { daemonLogChannel } from "../logging/logger.js";
import { registerMcp } from "../mcp/http.js";
import { registerWebUi } from "./static.js";

// T16 rider (ledgered at Task 12, optional): /api/status's top-level "version" comes from this
// package's own package.json instead of a hand-maintained literal. Read once at module load —
// resolves relative to THIS file both in dev (src/http/api.ts -> ../../package.json) and in the
// built image (dist/http/api.js -> ../../package.json), since both sit exactly two directories
// under the package root (src/http/ and dist/http/ mirror each other — rootDir:"src",
// outDir:"dist"). A read failure here would be a packaging bug worth surfacing loudly rather
// than papering over with a silent fallback string.
export const PACKAGE_VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string }
).version;

export interface Deps {
  cfg: DevdbConfig;
  state: StateDb;
  engine: EngineRuntime;
  logs: LogsService;
  // Phase 3 Task 1: required (unlike logger? below) — GET /api/events depends on it
  // unconditionally, and there is exactly one deps-construction helper per test file to update
  // (api.test.ts's per-call-site literals plus its listening() helper; mcp-http.test.ts's
  // fakeDeps()), unlike logger's ~25 scattered inline literals.
  events: EventsService;
  // Task 9 fix wave: optional (not required) so the ~25 pre-existing inline Deps literals across
  // api.test.ts/mcp-http.test.ts's fakeDeps() — none of which exercise anything logger-related —
  // don't all need editing just to satisfy a new required field. Only mcp/tools.ts's guard()
  // reads this, falling back to console.error when absent (see tools.ts's guard() comment).
  logger?: Logger;
  // Task 10 (dynamic-pg-builds): required (unlike Task 9's optional placeholder above) — the
  // pg-builds REST routes below call registry/provisioner unconditionally, and GET /api/status's
  // pgBuilds block (also below) is no longer the Task-1 `{}` stopgap. `computes` is new at this
  // task: none of the OTHER services expose a `runningPgbins()` passthrough (it's a private ctor
  // dep of ProjectsService/BranchesService/EndpointsService, consumed internally — see
  // engine-api.ts's ComputesApi), so the routes that need "which pgbins are currently running"
  // (GET /api/pg-builds's inUse, DELETE's in-use guard) take the compute manager directly here
  // rather than reaching through an unrelated service's public surface for it.
  registry: BuildRegistry;
  provisioner: Provisioner;
  computes: ComputesApi;
  services: {
    projects: ProjectsService; branches: BranchesService; endpoints: EndpointsService;
    timetravel: TimeTravelService; sql: SqlService;
  };
}

// The generalized shape sseStream() (below, inside buildServer) fans out over: a channel-agnostic
// replay-then-live SSE source. `replay` is already-serialized SSE payload strings (oldest-first);
// `subscribe` wires the live tail and returns an unsubscribe function. The logs SSE routes adapt
// LogsService's recent()/subscribe() to this shape; /api/events adapts EventsService with an
// always-empty replay (see that route's own comment for why that's a contract, not a gap).
interface SseSource {
  replay: string[];
  subscribe: (cb: (payload: string) => void) => () => void;
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
    // Task 10: real registry-backed block, replacing the Task-1 `{}` stopgap. Keyed by major as
    // a string (the wire contract — see PgMajorStatusDto/StatusDto's own doc comments in shared).
    // `active` here means the row BuildRegistry.resolveActives() picked as this major's exclusive
    // winner AND that's still ready — not merely "some row happens to have active=1 set", though
    // in practice those never diverge (resolveActives/activate keep the flag in sync with status).
    const pgBuilds: Record<string, PgMajorStatusDto> = {};
    for (const major of deps.registry.installedMajors()) {
      const active = deps.registry.list().find((r) => r.major === major && r.active && r.status === "ready") ?? null;
      pgBuilds[String(major)] = {
        activeVersion: active?.minor != null ? `${active.major}.${active.minor}` : null,
        source: active?.source ?? null,
        degradedDowngrade: deps.registry.degradedMajors().includes(major),
        updateAvailable: deps.provisioner.updateAvailableFor(major),
      };
    }
    return {
      version: PACKAGE_VERSION, healthy, engine,
      portRange: deps.cfg.portRange,
      storage: "none" as const, // phase 4 wires real modes (spec §Daemon additions)
      pgBuilds,
    };
  });

  // Open SSE responses, tracked so preClose (below) can end them explicitly. Fastify's own docs
  // for both `close()`'s shutdown lifecycle and the `preClose` hook call this out by name: an
  // SSE stream is (from the HTTP server's point of view) a request that never completes, so
  // `server.close()` — which "waits for all in-flight requests to complete" — would otherwise
  // hang for as long as any client stays connected, silently eating this daemon's 45s hard-exit
  // budget in index.ts's shutdown() before engine/computes ever get torn down.
  const openSseResponses = new Set<FastifyReply["raw"]>();

  // Mounted here (before the preClose hook below references it) so the session-stateful /mcp
  // transport's own in-flight streams get the same shutdown treatment as SSE: registerMcp's
  // closeAll() drains every open MCP session (clears the idle-sweep interval, closes every
  // transport) within the daemon's 45s shutdown budget, instead of letting index.ts's hard-exit
  // escalation be the only thing that ever ends them.
  const mcp = registerMcp(app, deps);

  app.addHook("preClose", async () => {
    for (const raw of openSseResponses) raw.end();
    await mcp.closeAll();
  });

  // Replays source.replay (already-serialized SSE payload strings, oldest-first) as one SSE event
  // per entry, then subscribes for the live tail. reply.hijack() is Fastify's documented mechanism
  // for handing a reply fully over to raw Node writes (see Reply.md's .hijack() section): without
  // it, this being an async route handler means Fastify calls reply.send() on whatever the handler
  // eventually returns once its promise settles — which would race/conflict with the raw writes
  // already in flight on the same socket. Unsubscribes AND drops the openSseResponses entry on the
  // underlying response socket's "close" — fires on an explicit client disconnect, a dropped
  // connection, or reply.raw.end() (including the preClose hook's own end() call above) — so a
  // client that simply stops reading (tab closed, curl killed) doesn't leak a subscriber callback
  // inside the source forever, and a long-disconnected client doesn't linger in this Set either.
  //
  // flushHeaders() is load-bearing, not defensive: verified empirically (Node's http.
  // ServerResponse can leave writeHead()'s headers sitting in its internal buffer until the
  // first body write() or end()) that a source with an empty replay — no backlog write() follows
  // writeHead() — leaves the client's fetch()/EventSource hanging with headers never observed as
  // sent, until the FIRST live entry arrives (which may be never, for a daemon component that
  // hasn't logged anything yet, a freshly-started compute, or the no-replay /api/events channel).
  // Every client must see its 200 + headers immediately on connect regardless of whether there's
  // backlog to replay.
  // Fix 2 (review): backpressure + write-safety hardening. Node's http.ServerResponse.write()
  // returns `false` when the socket's internal buffer is over its highWaterMark — this is the
  // documented signal that the client (or its network path) is reading slower than this server is
  // producing lines. Buffering unboundedly in that case (the pre-fix code did: every write() call
  // site ignored the return value) would let one slow SSE client's kernel/user-space write buffer
  // grow forever for as long as the source keeps producing entries, an unbounded per-connection
  // memory leak with no cap. The policy adopted here is intentionally simple and bounded: on the
  // FIRST slow-write signal (or a write that throws, or a write attempted against an already-
  // ended/destroyed socket), tear the connection down and unsubscribe — never buffer past that
  // point. The client's EventSource/fetch reconnects on its own (SSE's standard behavior) and
  // replays via source.replay from the top, so no lines are silently lost forever — just re-
  // delivered on the next connection, which is a far safer failure mode than an unbounded write
  // buffer. (The /api/events source's replay is always `[]` by contract — see its route — so this
  // reconnect-and-replay safety net doesn't apply there; see that route's own comment.)
  function sseStream(reply: FastifyReply, source: SseSource): void {
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
    // source.subscribe() ever runs — can still call teardown() safely instead of throwing a
    // temporal-dead-zone ReferenceError. Reassigned to the real unsubscribe closure once
    // source.subscribe() is actually called, further down.
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
    //
    // `payload` is interpolated as-is — it is ALREADY the exact SSE `data:` text the source wants
    // on the wire (see SseSource's doc comment: "already-serialized"). Each adapter is responsible
    // for its own encoding: the logs adapter JSON.stringify()s a raw log line (producing a quoted
    // JSON string on the wire, e.g. `data: "live line"`), while the /api/events adapter
    // JSON.stringify()s the event OBJECT (producing an unquoted JSON object on the wire, e.g.
    // `data: {"type":"branch.created",...}` — the wire contract GET /api/events promises). Doing
    // the encoding here unconditionally (the pre-Task-1 code did, when this only ever served
    // LogsService) would double-encode the object case — verified empirically while building this
    // route: a naive `JSON.stringify(payload)` here on an already-JSON.stringify'd object turns it
    // into a JSON STRING containing escaped JSON text, which a single JSON.parse() on the client
    // unwraps to a string, not the event object.
    function safeWrite(payload: string): boolean {
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        teardown();
        return false;
      }
      try {
        const ok = reply.raw.write(`data: ${payload}\n\n`);
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
    for (const line of source.replay) {
      // Abort the replay loop on the first failed write — teardown() has already unsubscribed
      // and ended the response, so continuing to iterate would just call write() again against
      // an already-ended socket for no benefit.
      if (!safeWrite(line)) { replayFailed = true; break; }
    }

    // If the replay loop above already tore this connection down (dead socket, or backpressure
    // on the very first replayed line), skip subscribing entirely — there is nothing live left to
    // feed, and registering a subscriber here just to have its very next callback immediately
    // hit safeWrite()'s writableEnded/destroyed check and call teardown() again would be pure
    // waste (and a — harmless but pointless — brief live entry in the source's subscriber Set).
    if (replayFailed) return;

    unsub = source.subscribe((line) => {
      safeWrite(line);
    });
    openSseResponses.add(reply.raw);
    reply.raw.on("close", () => {
      unsub();
      openSseResponses.delete(reply.raw);
    });
  }

  // Logs SSE keeps replay-then-live semantics, now as a thin adapter over sseStream(). Each raw
  // log line is JSON.stringify()'d here — this adapter's own encoding step, per SseSource's
  // "already-serialized" contract (sseStream/safeWrite interpolates payloads as-is; see its
  // comment) — reproducing the exact wire bytes (`data: "<line>"\n\n`) the pre-existing logs-SSE
  // tests assert.
  function sse(reply: FastifyReply, channel: string): void {
    sseStream(reply, {
      replay: deps.logs.recent(channel).map((line) => JSON.stringify(line)),
      subscribe: (cb) => deps.logs.subscribe(channel, (line) => cb(JSON.stringify(line))),
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
    "storcon_db", "storage_broker", "storage_controller", "safekeeper", "pageserver", "app",
  ]);
  app.get("/api/daemon/logs/:component", async (req, reply) => {
    const { component } = req.params as { component: string };
    if (!DAEMON_LOG_COMPONENTS.has(component)) {
      throw new DevdbError(404, `unknown daemon component: ${JSON.stringify(component)}`);
    }
    sse(reply, daemonLogChannel(component));
  });

  // Phase 3 (spec Decision 1): state-change invalidation hints. NO replay — `replay: []` is the
  // contract, not an optimization: clients blanket-invalidate on every (re)connect, which is what
  // makes lost events and reconnects free of correctness concerns.
  app.get("/api/events", async (_req, reply) => {
    sseStream(reply, {
      replay: [],
      subscribe: (cb) => deps.events.subscribe((e) => cb(JSON.stringify(e))),
    });
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

  // Task 12: REST fork-context parity — the spec requires non-MCP callers (this route) to be
  // able to attach the same fork context (git_branch/workdir/agent/purpose/client) that MCP's
  // create_branch tool does. createdBy below stays the literal "api" — this route is explicitly
  // the non-MCP path.
  const CreateBranch = z.object({
    name: z.string(),
    parentBranchId: z.string().optional(),
    atLsn: z.string().optional(),
    context: BranchContextSchema.optional(),
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

  // Phase 3 Task 4: rename. `slug` never changes (see BranchesService.rename's own comment) —
  // this route is a thin HTTP wrapper; all validation/semantics live service-side.
  const RenameBranch = z.object({ name: z.string() });
  app.patch("/api/branches/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = RenameBranch.parse(req.body);
    const row = await deps.services.branches.rename(id, body.name);
    return toBranchDto(await deps.services.branches.detail(row));
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

  // Task 10 (dynamic-pg-builds): REST over BuildRegistry (rows/status queries — synchronous,
  // in-process SQLite) + Provisioner (check/pull/remove — the only routes with real I/O: OCI
  // registry egress and filesystem work). GET is a pure read; the four mutating routes below all
  // delegate to the registry/provisioner for validation (409s come from assertRemovable/activate's
  // downgrade guard/the pull mutex, not from anything checked here) — this file stays a thin HTTP
  // adapter, same posture as every other route above it.
  app.get("/api/pg-builds", async () => {
    const runningPgbins = deps.computes.runningPgbins();
    return deps.registry.list().map((row) => toPgBuildDto(row, runningPgbins));
  });

  // Body-optional: an absent (or empty) `majors` defaults to every currently-installed major —
  // "recheck what I have" is the common case; an explicit array (e.g. probing a not-yet-installed
  // major before pulling it) is the exception. THE only egress trigger besides pull() itself —
  // both hit the OCI registry over the network, everything else in this block is local-only.
  // FIX-7 (final review): majors are bounded by PgVersionSchema (int, gte 14) like PullBody's —
  // an unbounded int reached provisioner.check, whose raw fetch error on a nonsense major
  // surfaced as a 500 on a public route instead of this 400.
  const CheckBody = z.object({ majors: z.array(PgVersionSchema).optional() });
  app.post("/api/pg-builds/check", async (req) => {
    const body = CheckBody.parse(req.body ?? {});
    const majors = body.majors ?? deps.registry.installedMajors();
    return deps.provisioner.check(majors);
  });

  // 202, not 200: pull() returns as soon as the `downloading` row is inserted — the real work
  // (OCI pull, fixup, validation gate, auto-activate) runs after this response is sent. Callers
  // poll GET /api/pg-builds (or the pg_builds SSE event) for the row's status to advance. A
  // concurrent pull is the provisioner's own global-mutex 409 (see Provisioner.pull), surfaced
  // through the standard DevdbError branch of the error handler above — no special-casing here.
  const PullBody = z.object({ major: PgVersionSchema, tag: z.string().min(1).optional() });
  app.post("/api/pg-builds/pull", async (req, reply) => {
    const body = PullBody.parse(req.body);
    const result = await deps.provisioner.pull(body);
    return reply.status(202).send(result);
  });

  // Explicit activation (e.g. picking an older build from the UI, or clearing a degraded-downgrade
  // flag with consent). Fix round 1 (review of Task 10 commit 3bfc859, Fix #2, P3 — mutation
  // lane): this route used to call registry.activate() + provisioner.recomposeDistrib() +
  // events.publish() directly, un-serialized with DELETE's provisioner.remove() below — a
  // concurrent activate/delete for the same row could interleave (activate flips the row active
  // + recomposes while remove() is mid-`rm`, which then deletes the just-activated build anyway,
  // stranding the major). Provisioner.activate() now runs that same sequence inside its private
  // mutation lane (see Provisioner's own doc comments on runMutation/activate for the race this
  // closes and Fix #1's accepted-tradeoff note on a recompose failure after the pointer commits).
  const ActivateBody = z.object({ consented: z.boolean().optional() });
  app.post("/api/pg-builds/:id/activate", async (req) => {
    const { id } = req.params as { id: string };
    const body = ActivateBody.parse(req.body ?? {});
    const row = await deps.provisioner.activate(id, { consented: body.consented });
    return toPgBuildDto(row, deps.computes.runningPgbins());
  });

  app.delete("/api/pg-builds/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await deps.provisioner.remove(id, deps.computes.runningPgbins());
    return reply.status(204).send();
  });

  registerWebUi(app, deps.cfg); // must stay last — SPA fallback owns the not-found handler
  return app;
}
