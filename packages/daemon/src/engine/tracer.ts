import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// DevDB's own no-op OTLP sink so the engine's tracing export never blocks; the engine emits to
// TRACER_PORT (OTLP/HTTP default 4318). It absorbs BOTH the engine binaries' OTLP trace exports
// (POST /v1/traces) AND the storage_controller's control-plane compute-notify upcalls (its
// `--control-plane-url http://127.0.0.1:4318`, e.g. POST /notify-attach — see engine/configs.ts
// storconSpec). Without a listener there, every export and every upcall hits a dead port: the
// binaries log a connection-refused error on a growing-backoff retry loop (observed live
// 2026-07-04, both the OTLP BatchSpanProcessor and the storage_controller notify_attach
// reconciler). The handler answers ANY method + ANY path with 200 "{}" — good enough to keep both
// clients quiet. Loopback-only, matching every other engine port's in-container posture. DevDB
// shipped the storcon arg pointing here (Task-1 port) but never had a sink — this closes that gap.
export class Tracer {
  private server: Server | null = null;

  constructor(
    private port: number,
    private onLine?: (line: string) => void,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        // Discard the request body (OTLP protobuf / notify JSON — never read) so the socket drains,
        // then answer 200 "{}" unconditionally, for every method and path — good enough to keep
        // both the OTLP exporter and the storage_controller upcall client quiet.
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(this.port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        this.server = server;
        this.onLine?.(`listening on 127.0.0.1:${this.boundPort}`);
        resolve();
      });
    });
  }

  // The actually-bound port — equals the constructor `port` in production (4318), or the
  // OS-assigned port when constructed with 0 (unit tests, so they never contend for the real 4318).
  get boundPort(): number {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? (addr as AddressInfo).port : this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return; // idempotent + safe before start()
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Force keep-alive sockets (the engine binaries hold them open) shut so close() can't hang
      // past the daemon's shutdown budget — Node 18.2+; guarded for safety.
      server.closeAllConnections?.();
    });
  }
}
