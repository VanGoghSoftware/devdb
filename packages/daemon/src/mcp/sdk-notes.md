# MCP SDK API surface — pinned from installed `.d.ts` (Task 7)

Source of truth: `@modelcontextprotocol/sdk@1.29.0` (resolved by `minimumReleaseAge: 1440`;
"latest" at plan-authoring time). Read directly from the installed package via the daemon's
`node_modules` symlink into the pnpm store:

```
packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts
packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.d.ts
packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts
packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts
packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.d.ts
packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts (isInitializeRequest, Implementation, ServerCapabilities)
```

All names below are copied verbatim from those files. **Every item marked ⚠️ DIFFERS is a
real discrepancy from the plan/brief's assumption — Tasks 8–11 must use the name given here,
not the assumed one.** The pinned `.d.ts` wins per the oracle-rule discipline this task mirrors.

---

## ⚠️ Structural surprise: the options type is NOT in `streamableHttp.d.ts`

The brief expected `StreamableHTTPServerTransport`'s constructor options to be readable via
`sed -n '1,80p' streamableHttp.d.ts`. In 1.29.0 that file only re-exports a **type alias**:

```typescript
// server/streamableHttp.d.ts
import { WebStandardStreamableHTTPServerTransportOptions, EventStore, StreamId, EventId } from './webStandardStreamableHttp.js';
export type StreamableHTTPServerTransportOptions = WebStandardStreamableHTTPServerTransportOptions;
```

The actual option fields live in **`server/webStandardStreamableHttp.d.ts`**, on
`WebStandardStreamableHTTPServerTransportOptions`. `StreamableHTTPServerTransport` (Node.js
wrapper) is "a thin wrapper around `WebStandardStreamableHTTPServerTransport`" using
`@hono/node-server` to bridge Node's `IncomingMessage`/`ServerResponse` to Web-standard
`Request`/`Response`. Tasks 8–11 must read `webStandardStreamableHttp.d.ts` for the options
shape, not `streamableHttp.d.ts`.

---

## `StreamableHTTPServerTransportOptions` (= `WebStandardStreamableHTTPServerTransportOptions`)

All fields, verbatim (`server/webStandardStreamableHttp.d.ts:41-103`):

```typescript
export interface WebStandardStreamableHTTPServerTransportOptions {
    sessionIdGenerator?: () => string;
    onsessioninitialized?: (sessionId: string) => void | Promise<void>;
    onsessionclosed?: (sessionId: string) => void | Promise<void>;
    enableJsonResponse?: boolean;
    eventStore?: EventStore;
    /** @deprecated Use external middleware for host validation instead. */
    allowedHosts?: string[];
    /** @deprecated Use external middleware for origin validation instead. */
    allowedOrigins?: string[];
    /** @deprecated Use external middleware for DNS rebinding protection instead. */
    enableDnsRebindingProtection?: boolean;
    retryInterval?: number;
}
```

Real names for the fields the brief asked about:

| Brief's assumed concept | Real name | Notes |
|---|---|---|
| session-id generator | `sessionIdGenerator?: () => string` | Omit/undefined → stateless mode. Matches brief. |
| DNS-rebinding flag | `enableDnsRebindingProtection?: boolean` | Matches brief's name. **⚠️ DIFFERS: marked `@deprecated`** — the doc comment says "Use external middleware for DNS rebinding protection instead." Same for `allowedHosts`/`allowedOrigins` below. Still present and functional in 1.29.0 (deprecation is a steer, not a removal), but Task 9 (the DNS-rebinding guard) should decide explicitly whether to use these SDK-level options or implement the Host/Origin check as Fastify preHandler middleware ahead of `transport.handleRequest`. Given the deprecation notice, **prefer the external-middleware approach** for the guard itself; these SDK options can still be set defensively as belt-and-suspenders if desired, but do not rely on them being the primary control.
| host allowlist | `allowedHosts?: string[]` | ⚠️ Deprecated (see above). |
| origin allowlist | `allowedOrigins?: string[]` | ⚠️ Deprecated (see above). |
| `onsessioninitialized` | `onsessioninitialized?: (sessionId: string) => void \| Promise<void>` | Matches brief's assumed name exactly. Called when server initializes a new session. |
| `onsessionclosed` | `onsessionclosed?: (sessionId: string) => void \| Promise<void>` | Matches brief's assumed name exactly. Called on session close **via a DELETE request** — explicitly NOT the same as transport `onclose` (doc: "this is different from the transport closing"). |
| `onclose` | **Not an option field.** It's a settable property on the transport instance itself: `transport.onclose = () => {...}` (see below). | ⚠️ DIFFERS in location: brief listed it alongside the two session callbacks as if it were a constructor option; it is not — it's assigned post-construction on `StreamableHTTPServerTransport`/`WebStandardStreamableHTTPServerTransport`. |

Additional fields the brief didn't ask about but Task 8 will likely want:
- `enableJsonResponse?: boolean` — plain JSON responses instead of SSE streaming (default `false`, SSE preferred).
- `eventStore?: EventStore` — resumability support (event replay after reconnect). Not required for our stateful-session design; skip unless a later task calls for resumable streams.
- `retryInterval?: number` — SSE client reconnection hint.

---

## `StreamableHTTPServerTransport` (Node.js wrapper) — instance surface

`server/streamableHttp.d.ts:58-121`, verbatim:

```typescript
export declare class StreamableHTTPServerTransport implements Transport {
    constructor(options?: StreamableHTTPServerTransportOptions);
    get sessionId(): string | undefined;
    set onclose(handler: (() => void) | undefined);
    get onclose(): (() => void) | undefined;
    set onerror(handler: ((error: Error) => void) | undefined);
    get onerror(): ((error: Error) => void) | undefined;
    set onmessage(handler: ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined);
    get onmessage(): ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined;
    start(): Promise<void>;
    close(): Promise<void>;
    send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }): Promise<void>;
    handleRequest(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown): Promise<void>;
    closeSSEStream(requestId: RequestId): void;
    closeStandaloneSSEStream(): void;
}
```

- **`transport.handleRequest(req, res, parsedBody?)`** — matches the brief exactly. Signature:
  `(req: IncomingMessage & {auth?: AuthInfo}, res: ServerResponse, parsedBody?: unknown) => Promise<void>`.
  Works directly with Fastify's raw `req.raw`/`res.raw` (Node http objects), not Fastify's
  wrapped request/reply — Task 9's `/mcp` route handler must pass the raw objects.
- **`transport.sessionId`** — matches the brief: `get sessionId(): string | undefined`.
- **`onclose`** is a get/set **property pair on the instance**, assigned after construction:
  `const t = new StreamableHTTPServerTransport({...}); t.onclose = () => {...};` — it is
  NOT a constructor option (see discrepancy table above). No `onsessionclosed`-equivalent
  exists at this level; that hook is a constructor option (passes through from
  `WebStandardStreamableHTTPServerTransportOptions`), separate from `onclose`.
- No `onsessioninitialized`/`onsessionclosed` getters/setters appear on
  `StreamableHTTPServerTransport` itself — they are **constructor-only** options (set once,
  not re-settable properties). Confirmed by grepping the class body: only `onclose`,
  `onerror`, `onmessage` are exposed as instance accessors.
- `close()` returns `Promise<void>` and "closes the transport and all active connections."
- `closeSSEStream`/`closeStandaloneSSEStream` — new in this SDK generation, not mentioned in
  the brief; useful for polling-based reconnect patterns. Not required for Tasks 8-11's baseline
  design; note for future reference only.

---

## `McpServer` constructor + capabilities/instructions

`server/mcp.d.ts:14-24` + `server/index.d.ts:7-46` (verbatim):

```typescript
// mcp.d.ts
export declare class McpServer {
    readonly server: Server;
    constructor(serverInfo: Implementation, options?: ServerOptions);
    ...
}

// index.d.ts — ServerOptions (imported by mcp.d.ts from './index.js')
export type ServerOptions = ProtocolOptions & {
    capabilities?: ServerCapabilities;
    instructions?: string;
    jsonSchemaValidator?: jsonSchemaValidator;
};
```

- Constructor: **`new McpServer(serverInfo: Implementation, options?: ServerOptions)`** —
  matches the brief's assumed shape (name/version + capabilities/instructions), but
  `capabilities` and `instructions` are NOT top-level constructor args — they are fields
  **inside the second `options` object**, itself typed `ServerOptions = ProtocolOptions & {capabilities?, instructions?, jsonSchemaValidator?}`.
  Example: `new McpServer({ name: "devdb", version: "0.1.0" }, { instructions: INSTRUCTIONS_TEXT, capabilities: { tools: {} } })`.
- **`Implementation`** (`types.d.ts:8016`, via `ImplementationSchema`) = `{ name: string; version: string; title?: string; websiteUrl?: string; description?: string; icons?: [...] }`. Only `name`+`version` are required — matches the smoke test's `{ name: "devdb", version: "0.0.0" }`.
- **`instructions?: string`** — matches the brief exactly. Surfaced to the client at `initialize` (per `ServerOptions` doc comment: "Optional instructions describing how to use the server and its features.").
- **`capabilities?: ServerCapabilities`** — matches the brief's name. Must be set (even `{}` for tools) or `registerTool`/`server.setRequestHandler` calls may be rejected by `assertCapabilityForMethod` (see `Server` class, `index.d.ts:112`).
- `McpServer.server` (readonly) is the underlying low-level `Server` instance — this is the path to `getClientVersion()` (see below).

---

## `registerTool` — input schema shape: ZodRawShape vs ZodObject

⚠️ **DIFFERS from the brief's framing.** The brief asked to pin "ZodRawShape vs ZodObject" as
if choosing between the two zod-native types. The real type is neither directly — it's a
**custom compat type** defined in `server/zod-compat.d.ts`, built to support both zod v3 and
v4 schemas simultaneously:

```typescript
// server/zod-compat.d.ts
export type AnySchema = z3.ZodTypeAny | z4.$ZodType;
export type AnyObjectSchema = z3.AnyZodObject | z4.$ZodObject | AnySchema;
export type ZodRawShapeCompat = Record<string, AnySchema>;
```

`registerTool`'s real signature (`server/mcp.d.ts:150-157`):

```typescript
registerTool<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;      // ZodRawShapeCompat (raw shape object) OR AnySchema (a full zod object schema)
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  cb: ToolCallback<InputArgs>
): RegisteredTool;
```

- **`inputSchema` accepts EITHER shape**: a raw shape object (`ZodRawShapeCompat = Record<string, AnySchema>`, e.g. `{ projectId: z.string(), branchId: z.string() }` — a plain object of zod schemas, NOT wrapped in `z.object(...)`) **OR** a fully-constructed zod object schema (`AnySchema`, e.g. `z.object({...})` itself). Both are valid for `InputArgs`.
- Tasks 8–11's 10 tool definitions should use the **raw-shape form** (`{ field: z.string(), ... }`) for consistency and brevity — this matches typical SDK usage patterns and avoids an extra `z.object()` wrap. Either form type-checks.
- The callback's `args` param type is inferred via `ShapeOutput<Args>` (for raw shapes) or `SchemaOutput<Args>` (for full schemas) — both resolve to the parsed/validated TS type, same as plain zod's `z.infer`.
- `registerTool` is the **non-deprecated** entry point. The overloaded `tool(...)` methods (7 overloads, `mcp.d.ts:112-146`) are all marked `@deprecated Use registerTool instead` — Tasks 8–11 must call `registerTool`, not `tool`.
- Zod version note: the daemon's own `package.json` pins `"zod": "^3.24.0"`; the SDK's own dependency tree resolves `zod@3.25.76` internally (visible in `pnpm-lock.yaml` as `@modelcontextprotocol/sdk@1.29.0(zod@3.25.76)`). This is pnpm's normal per-package isolation — the SDK's `zod-compat` layer exists precisely to accept schemas built with either the daemon's zod instance or another. No action needed; schemas built with the daemon's installed `zod` (`import { z } from "zod"`) will satisfy `AnySchema` (`z3.ZodTypeAny`) as-is.

---

## Reading the connected client's info

Confirmed **matches the brief exactly**: `server.server.getClientVersion()`.

`server/index.d.ts:125`, on the low-level `Server` class (verbatim):

```typescript
/**
 * After initialization has completed, this will be populated with information about the client's name and version.
 */
getClientVersion(): Implementation | undefined;
```

- Access path from an `McpServer` instance: **`mcpServer.server.getClientVersion()`** —
  `McpServer.server` is the `readonly server: Server` field (`mcp.d.ts:18`). Returns
  `Implementation | undefined` (undefined before `initialize` completes).
- Companion: `server.server.getClientCapabilities(): ClientCapabilities | undefined` (`index.d.ts:121`) — not asked for by the brief but likely useful alongside client version for logging/telemetry.
- Per-tool-call session correlation does NOT require `getClientVersion()` — the `extra: RequestHandlerExtra<ServerRequest, ServerNotification>` param passed to every tool callback already carries `extra.sessionId?: string` directly (`shared/protocol.d.ts:185`), plus `extra.signal: AbortSignal` and `extra.authInfo?: AuthInfo`. Use `extra.sessionId` for per-call session lookups in tool handlers; reserve `getClientVersion()` for one-time post-initialize logging (e.g., "MCP client connected: <name>/<version>").

---

## `sendToolListChanged`

Confirmed **matches the brief exactly**. Present on both `McpServer` (`mcp.d.ts:206`) and the
underlying `Server` (`index.d.ts:193`):

```typescript
// McpServer
sendToolListChanged(): void;

// Server (low-level)
sendToolListChanged(): Promise<void>;
```

⚠️ **Return-type discrepancy between the two layers**: `McpServer.sendToolListChanged()` is
synchronous (`void`); the underlying `Server.sendToolListChanged()` (reached via
`mcpServer.server.sendToolListChanged()`) is `Promise<void>`. Tasks 8–11 will call it on the
`McpServer` instance directly (`mcpServer.sendToolListChanged()`) in the normal case — no
`await` needed there. Only `await` it if going through `.server.sendToolListChanged()`
directly (no expected use case for that path in this project).

Sibling notifications on `McpServer`, present but not asked for by the brief:
`sendResourceListChanged(): void`, `sendPromptListChanged(): void` — same sync/async split
pattern applies if ever called via `.server.*`.

---

## `isInitializeRequest`

`types.d.ts:772`, verbatim:

```typescript
export declare const isInitializeRequest: (value: unknown) => value is InitializeRequest;
```

Matches the brief's assumed name exactly. Note it's declared `const`, not `function` — no
practical difference in usage (`isInitializeRequest(body)` works identically), just noting the
declaration form since the brief didn't specify it. Import path: `@modelcontextprotocol/sdk/types.js`.
Typical use in Task 9's `/mcp` POST handler: decide whether an incoming request (no existing
session ID header) is a legitimate `initialize` call (create a new transport/session) versus
an invalid request that should be rejected.

---

## Summary table — brief's assumption vs pinned reality

| Brief asked to pin | Real name / location | Matches brief? |
|---|---|---|
| Session-id generator | `sessionIdGenerator?: () => string` on `WebStandardStreamableHTTPServerTransportOptions` (in `webStandardStreamableHttp.d.ts`, not `streamableHttp.d.ts`) | Name matches; **file location differs** |
| DNS-rebinding flag | `enableDnsRebindingProtection?: boolean` | Name matches; **now `@deprecated`** — prefer external middleware |
| Host/origin allowlists | `allowedHosts?: string[]`, `allowedOrigins?: string[]` | Names match; **now `@deprecated`** |
| `onsessioninitialized` | `onsessioninitialized?: (sessionId: string) => void \| Promise<void>` (constructor option) | Matches exactly |
| `onsessionclosed` | `onsessionclosed?: (sessionId: string) => void \| Promise<void>` (constructor option) | Matches exactly |
| `onclose` | Instance get/set property on the transport (`transport.onclose = () => {}`), **not a constructor option** | **Location differs** from how brief grouped it |
| `transport.handleRequest(req, res, parsedBody?)` | Exact match | Matches exactly |
| `transport.sessionId` | Exact match (`get sessionId(): string \| undefined`) | Matches exactly |
| `McpServer` ctor (capabilities, instructions) | `new McpServer(serverInfo: Implementation, options?: ServerOptions)`; `capabilities`/`instructions` are fields of `options`, not separate ctor args | Concept matches; **shape is nested, not flat** |
| `registerTool`/`tool` (ZodRawShape vs ZodObject) | Real type is `ZodRawShapeCompat = Record<string, AnySchema>` vs `AnySchema` (zod v3/v4 compat union), not literally zod's own `ZodRawShape`/`ZodObject` exports; `tool()` is deprecated, use `registerTool()` | **Type identity differs**; **deprecation of `tool()` not mentioned in brief** |
| Client info (`server.server.getClientVersion()`) | Exact match | Matches exactly |
| `sendToolListChanged` | Exact match on `McpServer` (sync); `Server`'s own copy is async | Matches exactly; **async/sync split across layers is new detail** |
| `isInitializeRequest` | Exact match, `types.d.ts:772` | Matches exactly |

**Bottom line for Tasks 8–11:** the biggest structural correction is that transport options
live in `webStandardStreamableHttp.d.ts`, not `streamableHttp.d.ts`; `McpServer`'s
`capabilities`/`instructions` are nested under a `ServerOptions` second argument, not flat
constructor params; and `registerTool`'s schema type is the SDK's own `ZodRawShapeCompat`
compat type, not raw zod. Everything else asked about in the brief matches by name.
