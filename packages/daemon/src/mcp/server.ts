import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_VERSION, type Deps } from "../http/api.js";
import { MCP_INSTRUCTIONS } from "./instructions.js";
// import { registerTools } from "./tools.js";   // ← uncommented in Task 9

export interface ToolCtx {
  deps: Deps;
  clientInfo: () => { name: string; version: string } | undefined;
}

// Builds one McpServer per session (registerMcp calls this from the initialize-request branch of
// its POST /mcp handler). Zero tools registered here — Task 9 wires registerTools once the tool
// surface exists; until then `listTools()` correctly returns [] and only the handshake
// (initialize + instructions) is exercised.
// deps/getClientInfo are unused until Task 9 wires registerTools(server, {deps, clientInfo}) —
// kept in the signature now so http.ts's call site doesn't change shape between the two tasks.
//
// Fix 3: no explicit `tools` capability. Passing `capabilities: { tools: {...} }` here (as this
// used to) tells clients at `initialize` that tools ARE supported, but with zero registerTool()
// calls the SDK never wires up its tools/list request handler (setToolRequestHandlers() only
// runs as a side effect of registerTool() itself — see mcp-handshake.test.ts's tripwire comment)
// — so a client would see the capability advertised, call tools/list or tools/call, and get back
// a bare -32601 Method not found with no clue why. Advertising a capability the server can't
// actually serve is worse than advertising none. Task 9's registerTool() calls will make the SDK
// auto-advertise the tools capability (including listChanged) the moment the first tool is
// registered — no manual capabilities object needed at all once that lands.
export function buildMcpServer(deps: Deps, getClientInfo: ToolCtx["clientInfo"]): McpServer {
  const server = new McpServer(
    { name: "devdb", version: PACKAGE_VERSION },
    { instructions: MCP_INSTRUCTIONS },
  );
  // registerTools(server, { deps, clientInfo: getClientInfo });   // ← Task 9
  return server;
}
