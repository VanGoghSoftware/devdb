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

  // Task 8 lands zero tools (Task 9 registers the real 10). Verified against the installed SDK
  // (@modelcontextprotocol/sdk@1.29.0, dist/esm/server/mcp.js): McpServer only wires up the
  // tools/list JSON-RPC handler as a side effect of registerTool() being called at least once
  // (setToolRequestHandlers() is invoked from inside registerTool()'s body, never from the
  // constructor, and is `private` in the .d.ts — there's no public zero-tools-friendly way to
  // force it). Passing `capabilities: { tools: {...} }` to the constructor only affects what's
  // negotiated at initialize; it does NOT register the tools/list method handler on the
  // underlying Server. So a zero-tool McpServer genuinely has no tools/list handler at all, and
  // the brief's original assertion (`listTools()` resolves to `{ tools: [] }`) does not hold
  // against the real SDK — corrected here to assert the actual, verified behavior: the call
  // rejects with JSON-RPC -32601 Method not found, which is the honest signal for "no tools
  // capability yet" rather than a silently-wrong empty-array response. Task 9, once it registers
  // the first real tool, is expected to flip this same call to resolve with a populated list —
  // that's the natural regression check for this test's assumption no longer holding.
  it("has no tools/list handler yet — listTools() rejects with Method not found", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${dev.base}/mcp`)));
    await expect(client.listTools()).rejects.toThrow(/-32601/);
    await client.close();
  });
});
