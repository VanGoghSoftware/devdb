import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makeReadToolsHarness, type McpToolsHarness } from "./helpers/mcp-harness.js";

// Every read tool here only ever returns text content (mcp/format.ts's text()/errorResult()) —
// content[0]'s static type is nonetheless the SDK's full ContentBlock union (text/image/audio/
// resource/...), since that's what CallToolResult's real schema allows. This narrows with a
// runtime check (not a cast) so a regression that accidentally returned a non-text block would
// fail the assertion here rather than silently type-check past it.
function firstText(res: CallToolResult): string {
  const block = res.content[0];
  if (!block || block.type !== "text") {
    throw new Error(`expected a text content block, got: ${JSON.stringify(block)}`);
  }
  return block.text;
}

// Every response the MCP contract produces must open with a context line naming the project
// (plus branch, for branch-scoped tools) — see mcp/format.ts's contextLine(). These tests assert
// against the FIRST line of content[0].text specifically (not just "contains somewhere") so a
// regression that buries the context line after other text is still caught.
function firstLine(text: string): string {
  return text.split("\n")[0]!;
}

describe("MCP read tools", () => {
  let h: McpToolsHarness;
  afterEach(async () => { await h?.close(); });

  describe("get_status", () => {
    it("reports version/health/engine without needing a project", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("get_status", {});
      expect(res.isError).toBeFalsy();
      expect(firstText(res)).toMatch(/devdb/i);
    });
  });

  describe("create_project", () => {
    it("creates a project and opens with a context line naming it", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("create_project", { name: "shop" });
      expect(res.isError).toBeFalsy();
      expect(firstLine(firstText(res))).toMatch(/project "shop"/);
      expect(firstText(res)).toMatch(/main/); // main branch reported
      expect(firstText(res).toLowerCase()).toMatch(/next:/); // next-step hint
    });

    it("rejects a duplicate project name with an actionable error", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("create_project", { name: "shop" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/already exists/);
    });

    it("does not leak a password field into the response text", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("create_project", { name: "shop" });
      expect(firstText(res)).not.toMatch(/password/i);
    });
  });

  describe("list_projects", () => {
    it("opens with a context line and lists created projects", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("list_projects", {});
      expect(res.isError).toBeFalsy();
      expect(firstText(res)).toMatch(/shop/);
    });

    it("hints at create_project when there are none yet", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("list_projects", {});
      expect(res.isError).toBeFalsy();
      expect(firstText(res).toLowerCase()).toMatch(/create_project/);
    });
  });

  describe("list_branches", () => {
    it("resolves the project by name and renders the main branch with created_by", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("list_branches", { project: "shop" });
      expect(res.isError).toBeFalsy();
      expect(firstLine(firstText(res))).toMatch(/project "shop"/);
      expect(firstText(res)).toMatch(/main/);
      expect(firstText(res)).toMatch(/created_by=/);
    });

    it("404s with an actionable error for an unknown project", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("list_branches", { project: "nope" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_projects/);
    });
  });

  describe("get_branch", () => {
    it("returns branch status + a next-step hint, opening with a context line naming project and branch", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("get_branch", { project: "shop", branch: "main", ensure_running: false });
      expect(res.isError).toBeFalsy();
      expect(firstLine(firstText(res))).toMatch(/project "shop"/);
      expect(firstLine(firstText(res))).toMatch(/branch "main"/);
      expect(firstText(res).toLowerCase()).toMatch(/next:/);
    });

    it("on a missing project returns an actionable error naming list_projects", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("get_branch", { project: "nope", branch: "main" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_projects/);
    });

    it("on a missing branch (project exists) returns an actionable error naming list_branches", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("get_branch", { project: "shop", branch: "nope", ensure_running: false });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_branches/);
    });

    it("does not leak a password field into the response text", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("get_branch", { project: "shop", branch: "main", ensure_running: false });
      expect(firstText(res)).not.toMatch(/password/i);
    });
  });
});
