import type { LogsService } from "../services/logs.js";

export interface Logger {
  error(event: string, detail?: unknown): void;
  warn(event: string, detail?: unknown): void;
  info(event: string, detail?: unknown): void;
}

function fmt(detail: unknown): string {
  if (detail === undefined) return "";
  if (detail instanceof Error) return ` — ${detail.message}`;
  return ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
}

// channel is a LogsService channel name; it is exposed for SSE as `daemon:<channel>`
// via the DAEMON_LOG_COMPONENTS allowlist in http/api.ts (default "app").
export function createLogger(logs: LogsService, channel = "app"): Logger {
  const emit = (level: "error" | "warn" | "info", event: string, detail?: unknown) => {
    const line = `[${level}] ${event}${fmt(detail)}`;
    (level === "info" ? console.log : console.error)(line);
    logs.ingest(channel, line);
  };
  return {
    error: (e, d) => emit("error", e, d),
    warn: (e, d) => emit("warn", e, d),
    info: (e, d) => emit("info", e, d),
  };
}
