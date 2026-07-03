import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

describe("mcp sdk", () => {
  it("constructs a server and transport", () => {
    const server = new McpServer({ name: "devdb", version: "0.0.0" });
    expect(server).toBeDefined();
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "x" });
    expect(t).toBeDefined();
  });
});
