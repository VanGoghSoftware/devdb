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
export function buildMcpServer(deps: Deps, getClientInfo: ToolCtx["clientInfo"]): McpServer {
  const server = new McpServer(
    { name: "devdb", version: PACKAGE_VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions: MCP_INSTRUCTIONS },
  );
  // registerTools(server, { deps, clientInfo: getClientInfo });   // ← Task 9
  return server;
}
