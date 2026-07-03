import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("mcp handshake", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("initializes and exposes instructions", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${dev.base}/mcp`)));
    expect(client.getInstructions()).toContain("branch per task");
    await client.close();
  });

  // Task 9 flip (was Task 8's tripwire: "does NOT advertise a tools capability yet"). Task 8's
  // buildMcpServer passed no explicit `capabilities` object — correct at the time (zero tools
  // registered, so advertising `{ tools: {...} }` would have been a lie the SDK's own dispatcher
  // then contradicted on the first real tools/list call). Task 9's registerTools() call makes the
  // SDK auto-advertise `tools` the moment the first tool is registered: verified against the
  // installed SDK (@modelcontextprotocol/sdk@1.29.0, dist/esm/server/mcp.js's
  // setToolRequestHandlers()) — `registerTool()` calls
  // `this.server.registerCapabilities({ tools: { listChanged: true } })` as a side effect the
  // FIRST time any tool is registered, gated on a private `_toolHandlersInitialized` flag so it
  // only fires once regardless of how many tools get registered after the first. No manual
  // `capabilities` object in buildMcpServer's McpServer construction was needed to make this
  // happen — server.ts still passes none, and the capability shows up anyway, confirming the
  // auto-advertise behavior asserted here.
  it("advertises a tools capability (incl. listChanged) now that read tools are registered", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${dev.base}/mcp`)));
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
    await client.close();
  });

  // Task 9 flip (was Task 8's tripwire: "has no tools/list handler yet — listTools() rejects with
  // Method not found"). Task 9 registers the 5 read tools (get_status, list_projects,
  // create_project, list_branches, get_branch) — registerTool()'s side effect (see the sibling
  // test's comment above) wires up the real tools/list JSON-RPC handler, so listTools() now
  // genuinely resolves instead of rejecting with -32601. This is the natural regression check for
  // Task 8's own assumption ("no tools yet") no longer holding, and proves the handshake-level
  // (not just unit-level, see mcp-tools.test.ts) tool surface is live end-to-end over the real
  // Streamable-HTTP transport.
  it("lists exactly the 5 registered read tools via a real tools/list round-trip", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${dev.base}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["create_project", "get_branch", "get_status", "list_branches", "list_projects"].sort(),
    );
    await client.close();
  });
});
