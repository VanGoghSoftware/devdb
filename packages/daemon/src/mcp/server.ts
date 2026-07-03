import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_VERSION, type Deps } from "../http/api.js";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import { registerTools } from "./tools.js";

export interface ToolCtx {
  deps: Deps;
  clientInfo: () => { name: string; version: string } | undefined;
}

// Builds one McpServer per session (registerMcp calls this from the initialize-request branch of
// its POST /mcp handler).
//
// Task 8 landed this with zero tools and NO explicit `tools` capability: passing
// `capabilities: { tools: {...} }` at construction time would have told clients at `initialize`
// that tools ARE supported, but with zero registerTool() calls the SDK never wires up its
// tools/list request handler (setToolRequestHandlers() only runs as a side effect of
// registerTool() itself — see mcp.js's setToolRequestHandlers()/registerCapabilities call, and
// mcp-handshake.test.ts's now-flipped tripwire tests). Advertising a capability the server can't
// actually serve would have been worse than advertising none.
//
// Task 9: registerTools(server, ...) below calls server.registerTool() for the first time (5 read
// tools) — the SDK's own registerTool() implementation calls
// `this.server.registerCapabilities({ tools: { listChanged: true } })` as a side effect the FIRST
// time any tool is registered (mcp.js's setToolRequestHandlers(), gated on
// `_toolHandlersInitialized`), which both wires up the tools/list and tools/call JSON-RPC handlers
// AND makes that capability show up in the negotiated `initialize` result. No manual
// `capabilities` object is needed here at all — verified against mcp-handshake.test.ts's flipped
// assertions (tools capability present with listChanged:true, listTools() resolves the 5 tools).
export function buildMcpServer(deps: Deps, getClientInfo: ToolCtx["clientInfo"]): McpServer {
  const server = new McpServer(
    { name: "devdb", version: PACKAGE_VERSION },
    { instructions: MCP_INSTRUCTIONS },
  );
  registerTools(server, { deps, clientInfo: getClientInfo });
  return server;
}
