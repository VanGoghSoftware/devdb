import { inspect } from "node:util";
import type { LogsService } from "../services/logs.js";

export interface Logger {
  error(event: string, detail?: unknown): void;
  warn(event: string, detail?: unknown): void;
  info(event: string, detail?: unknown): void;
}

// Fix 2 (review, fix wave 2): single source of truth for the `daemon:<component>` channel
// format. Previously the SSE route (http/api.ts) inlined `` `daemon:${component}` ``,
// createLogger defaulted to the literal "daemon:app", and the wiring test reconstructed the
// format independently — three copies that could silently drift apart. All three now call this
// helper instead.
export function daemonLogChannel(component: string): string {
  return `daemon:${component}`;
}

// Fix 2 (review, fix wave): fmt() must be TOTAL — it is called from inside compensation
// handlers' best-effort .catch() callbacks (see services/branches.ts, projects.ts, endpoints.ts,
// timetravel.ts), where a throw here would propagate out of the .catch(), mask the original
// failure, and skip any cleanup steps still queued after it (e.g. a safekeeper delete queued
// after a pageserver delete already failed). JSON.stringify throws on circular references and on
// BigInt values — both are plausible caught-error shapes (an engine client error object that
// embeds a request/response with a cycle, or a numeric detail that happens to be a BigInt) — so
// the JSON.stringify branch is wrapped and falls back to util.inspect, which does not throw for
// either case.
function fmt(detail: unknown): string {
  if (detail === undefined) return "";
  if (detail instanceof Error) return ` — ${detail.message}`;
  if (typeof detail === "string") return ` — ${detail}`;
  try {
    return ` — ${JSON.stringify(detail)}`;
  } catch {
    return ` — ${inspect(detail, { depth: 2 })}`;
  }
}

// Fix 1 (review, fix wave): channel must be the FULL channel the SSE route subscribes to, not a
// bare component name. `GET /api/daemon/logs/:component` (http/api.ts) subscribes
// `` `daemon:${component}` `` — so `/api/daemon/logs/app` reads channel `daemon:app` exactly.
// Engine components (ManagedProcess, EmbeddedPostgres) already ingest to their own full
// `daemon:<name>` channel (e.g. `daemon:storcon_db`) for the same reason. This logger's default
// must match that convention — "daemon:app" — or compensation logs are ingested to a channel the
// SSE endpoint never reads, and the whole feature is a silent no-op (see
// test/logger.test.ts's "logger -> SSE channel wiring" tests for the end-to-end proof).
export function createLogger(logs: LogsService, channel = daemonLogChannel("app")): Logger {
  const emit = (level: "error" | "warn" | "info", event: string, detail?: unknown) => {
    const line = `[${level}] ${event}${fmt(detail)}`;
    // Fix 3 (review, fix wave): route ALL levels to stderr. info previously wrote console.log
    // (stdout), contradicting the stated stderr-fanout contract (daemon logs stay on stderr
    // uniformly; stdout is reserved). No `info` callers exist yet — this only fixes the contract
    // ahead of one showing up.
    console.error(line);
    logs.ingest(channel, line);
  };
  return {
    error: (e, d) => emit("error", e, d),
    warn: (e, d) => emit("warn", e, d),
    info: (e, d) => emit("info", e, d),
  };
}
