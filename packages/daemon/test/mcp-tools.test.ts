import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PACKAGE_VERSION } from "../src/http/api.js";
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

  // Fix 1 (task-9 fix wave, Important): guard() (mcp/tools.ts) is the SHARED error path every
  // tool's registerTool() callback is wrapped in — before this fix it did
  // `catch (e) { return errorResult(e.message) }` for EVERY throw, so an unexpected/programming
  // bug (a TypeError from a dependency, not a deliberate DevdbError) surfaced as a normal tool
  // error carrying the RAW internal message — hiding the bug from both the agent (who can't tell
  // "you typed the name wrong" from "the daemon has a bug") and from test/observability tooling
  // (nothing gets logged anywhere). These two tests are the discriminating pair: a DevdbError
  // (deliberate, actionable) still surfaces its message verbatim; anything else gets a generic
  // "check the daemon logs" remediation AND gets logged (with its stack) via the injected logger.
  describe("guard() error handling", () => {
    it("still surfaces a DevdbError's actionable message verbatim", async () => {
      h = await makeReadToolsHarness();
      // create_project's own duplicate-name 409 is a real DevdbError thrown by the service layer
      // — reused here rather than an ad-hoc throw so this exercises the actual production path.
      await h.call("create_project", { name: "shop" });
      const res = await h.call("create_project", { name: "shop" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/already exists/);
    });

    it("a non-DevdbError (e.g. TypeError) from a tool's service dependency becomes a generic remediation, and is logged with its stack", async () => {
      h = await makeReadToolsHarness();
      const bug = new TypeError("cannot read properties of undefined (reading 'toUpperCase')");
      // Injects a genuine programming-bug-shaped failure into list_projects' service dependency —
      // NOT a DevdbError, exactly the class of bug guard() must stop from leaking its raw message.
      vi.spyOn(h.deps.services.projects, "list").mockImplementation(() => { throw bug; });

      const res = await h.call("list_projects", {});

      expect(res.isError).toBe(true);
      // The raw internal message must NOT reach the caller...
      expect(firstText(res)).not.toContain(bug.message);
      // ...replaced by a generic, non-leaky remediation naming where to actually look.
      expect(firstText(res).toLowerCase()).toMatch(/internal error/);
      expect(firstText(res).toLowerCase()).toMatch(/daemon logs/);

      // ...and the fake logger must have recorded the failure, WITH the tool name and the error
      // (so its stack is available) — not silently swallowed.
      expect(h.engineFakes.logger.error).toHaveBeenCalledTimes(1);
      const [event, detail] = vi.mocked(h.engineFakes.logger.error).mock.calls[0]!;
      expect(event).toContain("list_projects");
      expect(detail).toBe(bug);
    });
  });

  describe("get_status", () => {
    it("reports version/health/engine without needing a project", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("get_status", {});
      expect(res.isError).toBeFalsy();
      expect(firstText(res)).toMatch(/devdb/i);
    });

    // Fix 2 (task-9 fix wave): the description promises version+health+engine but the text
    // omitted the version — asserts the SAME PACKAGE_VERSION value GET /api/status returns
    // (imported, not a hand-duplicated literal) actually appears in the tool's response text.
    it("includes the daemon version (same value GET /api/status returns)", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("get_status", {});
      expect(res.isError).toBeFalsy();
      expect(firstText(res)).toContain(PACKAGE_VERSION);
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

    // Fix 5 (task-9 fix wave): the response contract requires every error to name a remediation,
    // not just state the failure reason — a bare "already exists" tells an agent WHAT happened but
    // not what to do next. Asserted here (not just at the service level) because this is the
    // caller-visible tool contract Fix 5 targets.
    it("the duplicate-name error names a remediation (a different name, or the existing project)", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("create_project", { name: "shop" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/different name|list_projects/);
    });

    it("rejects an invalid project name and names the allowed syntax", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("create_project", { name: "!!!" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/invalid project name/);
      // the remediation must actually state the allowed characters, not just "invalid" — an
      // agent can't self-correct from "invalid" alone.
      expect(firstText(res)).toMatch(/letters|digits|alphanumeric|a-z/i);
    });

    // Fix 5: table-driven pgVersion coverage — the SDK's own zod inputSchema validation (not
    // tools.ts's own code) is the reject path for out-of-range values, so this also proves the
    // zod raw shape (PgVersionSchema.optional()) is wired correctly into the registered tool.
    describe("pgVersion coverage", () => {
      it.each([14, 15, 16, 17])("accepts pgVersion %d", async (pgVersion) => {
        h = await makeReadToolsHarness();
        const res = await h.call("create_project", { name: `shop-${pgVersion}`, pgVersion });
        expect(res.isError).toBeFalsy();
        expect(firstText(res)).toContain(`pg${pgVersion}`);
      });

      it.each([13, 18])("rejects pgVersion %d with a caller-actionable message", async (pgVersion) => {
        h = await makeReadToolsHarness();
        const res = await h.call("create_project", { name: "shop", pgVersion });
        expect(res.isError).toBe(true);
        // The SDK's zod-validation error path — not tools.ts's own guard()/DevdbError path — so
        // this doesn't assert the exact wording, only that SOME actionable text about pgVersion
        // reaches the caller rather than a silent/blank failure.
        expect(firstText(res).toLowerCase()).toMatch(/pgversion/);
      });
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

    // Fix 4 (task-9 fix wave): list_branches must convey the branch TREE (parent/child ancestry),
    // not a flat repo-order list — otherwise an agent looking at "main" and "feature" side by side
    // has no way to tell feature was forked from main once more than one non-main branch exists.
    // No create_branch MCP tool exists yet (that's Task 10) — per the fix brief, the child branch
    // is seeded directly through the service layer (h.deps.services.branches.create), exactly the
    // way a create_branch tool would eventually call the exact same service method.
    it("shows fork ancestry: a child branch is rendered under/attributed to its parent", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const project = h.deps.services.projects.byNameOr404("shop");
      const main = h.deps.services.branches.byProjectAndNameOr404(project.id, "main");
      await h.deps.services.branches.create({
        projectId: project.id, name: "feature", parentBranchId: main.id, createdBy: "mcp",
      });

      const res = await h.call("list_branches", { project: "shop" });
      expect(res.isError).toBeFalsy();
      const body = firstText(res);
      expect(body).toMatch(/main/);
      expect(body).toMatch(/feature/);
      // created_by/context still present per-branch (unchanged contract, Fix 4 is additive).
      expect(body).toMatch(/created_by=/);
      // The ancestry itself: "feature" must be legible as a child OF "main" — either an explicit
      // "(from main)"-style parent label next to "feature", or feature's line indented deeper
      // than main's (a literal tree). Assert on content, not a hardcoded exact rendering, so a
      // reasonable implementation choice (indentation vs. label) isn't over-fitted.
      const lines = body.split("\n");
      const mainLine = lines.find((l) => /\bmain\b/.test(l))!;
      const featureLine = lines.find((l) => /\bfeature\b/.test(l))!;
      const featureNamesMainAsParent = /from "?main"?/i.test(featureLine);
      const featureIndentedDeeperThanMain = (featureLine.match(/^\s*/)?.[0].length ?? 0)
        > (mainLine.match(/^\s*/)?.[0].length ?? 0);
      expect(featureNamesMainAsParent || featureIndentedDeeperThanMain).toBe(true);
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

    // Fix 3 (task-9 fix wave): the flagship contract — ensure_running DEFAULTS to true, so calling
    // get_branch with it simply omitted must start the endpoint and return a connection string.
    // Every other test in this file explicitly passes `ensure_running: false`, so this default
    // path was previously untested. Mirrors endpoints-service.test.ts's own post-start fixture
    // (`statusOf` "stopped" once, then "running"; `portOf` a concrete port) rather than inventing
    // a new mocking shape.
    it("with ensure_running omitted (defaults true), starts the endpoint and returns a connection string", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      vi.mocked(h.engineFakes.computes.statusOf).mockReturnValueOnce("stopped").mockReturnValue("running");
      vi.mocked(h.engineFakes.computes.portOf).mockReturnValue(54301);

      const res = await h.call("get_branch", { project: "shop", branch: "main" });

      expect(res.isError).toBeFalsy();
      expect(h.engineFakes.computes.start).toHaveBeenCalled();
      expect(firstLine(firstText(res))).toMatch(/project "shop"/);
      expect(firstLine(firstText(res))).toMatch(/branch "main"/);
      expect(firstText(res)).toMatch(/postgresql:\/\/.+@localhost:54301\/postgres/);
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

  // Task 10: the flagship "new worktree" move — create an isolated branch, auto-start its
  // endpoint, and return a connection string. The engine `fakes()` default (computes.start
  // resolves {port: 1}, statusOf() returns "stopped" always) doesn't make ensureRunning() observe
  // "running" post-start — mirrors branches-service.test.ts's own post-start fixture: statusOf
  // must flip to "running" once start() has actually been called, so connectionString() renders.
  describe("create_branch", () => {
    function primeRunningAfterStart(h: McpToolsHarness, port = 54301): void {
      vi.mocked(h.engineFakes.computes.statusOf).mockReturnValueOnce("stopped").mockReturnValue("running");
      vi.mocked(h.engineFakes.computes.portOf).mockReturnValue(port);
    }

    it("creates a branch off main, auto-starts it, and returns a connection string with a next-step hint", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);

      const res = await h.call("create_branch", { project: "shop", name: "agent/try-index" });

      expect(res.isError).toBeFalsy();
      expect(h.engineFakes.computes.start).toHaveBeenCalled();
      expect(firstLine(firstText(res))).toMatch(/project "shop"/);
      expect(firstLine(firstText(res))).toMatch(/branch "agent\/try-index"/);
      expect(firstText(res)).toMatch(/postgresql:\/\/.+@localhost:54301\/postgres/);
      expect(firstText(res).toLowerCase()).toMatch(/next:/);
    });

    // The task brief's headline scenario: fork context supplied by the caller must be recorded
    // ALONGSIDE the session's own captured clientInfo — an agent's context (git_branch/workdir/
    // purpose) plus a durable record of WHICH client/version actually made the fork, without the
    // caller ever being able to spoof the `client` field itself (it's server-added, not accepted
    // as caller input — see the client-less input schema in tools.ts).
    it("records fork context: caller fields AND the session's client are both folded into storage", async () => {
      h = await makeReadToolsHarness({ clientInfo: { name: "claude-code", version: "9.9" } });
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);

      const res = await h.call("create_branch", {
        project: "shop", name: "agent/try-index",
        context: { git_branch: "feat/idx", workdir: "/w", purpose: "add an index" },
      });
      expect(res.isError).toBeFalsy();
      expect(firstText(res)).toMatch(/postgresql:\/\//);

      const list = await h.call("list_branches", { project: "shop" });
      expect(firstText(list)).toMatch(/claude-code/); // session client folded into stored context
      expect(firstText(list)).toMatch(/add an index/); // caller's own context field preserved
      expect(firstText(list)).toMatch(/feat\/idx/);
      expect(firstText(list)).toMatch(/\/w/);
    });

    it("a bare call with no context still works (client-only context is stored)", async () => {
      h = await makeReadToolsHarness({ clientInfo: { name: "claude-code", version: "9.9" } });
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);

      const res = await h.call("create_branch", { project: "shop", name: "bare-fork" });

      expect(res.isError).toBeFalsy();
      expect(firstText(res)).toMatch(/postgresql:\/\//);
      const list = await h.call("list_branches", { project: "shop" });
      expect(firstText(list)).toMatch(/claude-code/);
    });

    it("forks off a named parent (not main) and names it in the context line", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);
      await h.call("create_branch", { project: "shop", name: "feature" });

      const res = await h.call("create_branch", { project: "shop", name: "feature-child", parent: "feature" });

      expect(res.isError).toBeFalsy();
      expect(firstLine(firstText(res))).toMatch(/forked from "feature"/);
    });

    it("resolves at_timestamp to an LSN on the parent (main) before creating", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);
      const project = h.deps.services.projects.byNameOr404("shop");
      const spy = vi.spyOn(h.deps.services.timetravel, "lsnAtTimestamp");

      const res = await h.call("create_branch", {
        project: "shop", name: "pitr-fork", at_timestamp: "2026-07-01T00:00:00Z",
      });

      expect(res.isError).toBeFalsy();
      const main = h.deps.services.branches.byProjectAndNameOr404(project.id, "main");
      expect(spy).toHaveBeenCalledWith(main.id, "2026-07-01T00:00:00Z");
    });

    it("on a missing project returns an actionable error naming list_projects", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("create_branch", { project: "nope", name: "x" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_projects/);
    });

    it("on a missing named parent returns an actionable error naming list_branches", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("create_branch", { project: "shop", name: "x", parent: "nope" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_branches/);
    });

    it("does not leak a password field into the response text", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);
      const res = await h.call("create_branch", { project: "shop", name: "agent/try-index" });
      expect(firstText(res)).not.toMatch(/password/i);
    });

    // Fix 1 (task-10 fix wave, Important): create_branch persists the branch THEN calls
    // ensureRunning() to auto-start its endpoint. If ensureRunning() throws (port exhaustion,
    // compute launch failure), the branch (the valuable data fork) already exists — the pre-fix
    // behavior let the shared guard() turn this into an opaque "internal error" / raw message, so
    // an agent seeing an error would retry create_branch with the SAME name, hit a 409 duplicate,
    // and be stuck with an orphaned branch it doesn't know about. The branch must NOT be deleted
    // (the endpoint is restartable — EndpointsService.startLocked's catch block, services/
    // endpoints.ts, ALREADY persists a durable endpointError on the branch row via
    // state.branches.updateEndpoint(..., {status:"failed", error}), exactly like
    // endpoints-service.test.ts's own "durably records the error message" fixture), so the fix
    // reads the branch back after the failure and surfaces that persisted error + a recovery path
    // naming get_branch/delete_branch — never another create_branch (which would just 409).
    it("when auto-start fails after the branch is created, reports a partial success naming the branch + endpoint_error + recovery, and does NOT delete the branch", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      vi.mocked(h.engineFakes.computes.start).mockRejectedValueOnce(new Error("compute_ctl exited before ready"));

      const res = await h.call("create_branch", { project: "shop", name: "agent/try-index" });

      // (a) names the created branch — same context-line contract as every other tool response.
      expect(firstLine(firstText(res))).toMatch(/project "shop"/);
      expect(firstLine(firstText(res))).toMatch(/branch "agent\/try-index"/);
      // The connection string the caller needs is genuinely absent (the endpoint never came up),
      // so this is still an error result — but a DIFFERENT one from an opaque failure: the body
      // must (b) state the branch was created, name the endpoint failure/persisted endpoint_error,
      // and point at get_branch/delete_branch — not another create_branch (which would 409).
      expect(res.isError).toBe(true);
      const body = firstText(res);
      expect(body.toLowerCase()).toMatch(/created/);
      expect(body).toMatch(/compute_ctl exited before ready/);
      expect(body).toMatch(/get_branch/);
      expect(body).toMatch(/delete_branch/);

      // (c) the branch STILL EXISTS — a follow-up list_branches shows it, proving create_branch
      // did not compensate/delete it away.
      const list = await h.call("list_branches", { project: "shop" });
      expect(firstText(list)).toMatch(/agent\/try-index/);
    });

    // Fix 2 (task-10 fix wave, fold): pins the spoof-safety property with an adversarial test —
    // the merge (`{ ...(context ?? {}), client: ctx.clientInfo() }`) is spoof-safe because `client`
    // is spread LAST (overwriting anything the caller could otherwise smuggle in under that key)
    // AND the input schema (BranchContextInputShape, above) has no `client` key at all, so the SDK
    // itself would strip it before tools.ts ever sees it — belt and suspenders. No prior test
    // actually supplied an ADVERSARIAL client value; this one does, with the harness's OWN
    // captured clientInfo deliberately set to a DIFFERENT value than the spoofed one, so a
    // regression that accidentally let caller input win (e.g. spread-order flip) would be caught.
    it("drops a caller-supplied context.client (schema has no such key) — the SERVER-captured session client always wins", async () => {
      h = await makeReadToolsHarness({ clientInfo: { name: "claude-code", version: "9.9" } });
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);

      const res = await h.call("create_branch", {
        project: "shop", name: "agent/try-index",
        // `client` isn't part of CreateBranchShape's context schema, so the SDK's own validation
        // should strip it — but even if it somehow reached tools.ts, the merge order must still
        // win. Passing it via an untyped bag mirrors an adversarial caller who ignores the
        // declared schema (a real MCP client is not obligated to only ever send valid shapes).
        context: { purpose: "legit reason", client: { name: "FAKE", version: "0" } } as Record<string, unknown>,
      });
      expect(res.isError).toBeFalsy();

      const list = await h.call("list_branches", { project: "shop" });
      const body = firstText(list);
      expect(body).toMatch(/claude-code/); // the server-captured session client
      expect(body).not.toMatch(/FAKE/); // never the caller-spoofed one
    });

    // Fix 3 (task-10 fix wave, fold): pins persisted ancestry, at_timestamp-on-named-parent, and
    // createdBy by spying on the actual service calls create_branch makes — not just the response
    // TEXT (which could say "forked from X" while the underlying create() call received something
    // else entirely, e.g. main's id by mistake).
    describe("persisted ancestry, at_timestamp resolution, and createdBy (spy on the service calls)", () => {
      it("a named-parent fork persists parentBranchId as the PARENT's id, not main's", async () => {
        h = await makeReadToolsHarness();
        await h.call("create_project", { name: "shop" });
        primeRunningAfterStart(h);
        const project = h.deps.services.projects.byNameOr404("shop");
        await h.call("create_branch", { project: "shop", name: "feature" });
        const parent = h.deps.services.branches.byProjectAndNameOr404(project.id, "feature");
        const main = h.deps.services.branches.byProjectAndNameOr404(project.id, "main");
        const spy = vi.spyOn(h.deps.services.branches, "create");

        const res = await h.call("create_branch", { project: "shop", name: "feature-child", parent: "feature" });

        expect(res.isError).toBeFalsy();
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ parentBranchId: parent.id }));
        expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ parentBranchId: main.id }));
      });

      it("at_timestamp + a named parent resolves the LSN against the PARENT (not main), and passes the resolved atLsn into branches.create", async () => {
        h = await makeReadToolsHarness();
        await h.call("create_project", { name: "shop" });
        primeRunningAfterStart(h);
        const project = h.deps.services.projects.byNameOr404("shop");
        await h.call("create_branch", { project: "shop", name: "feature" });
        const parent = h.deps.services.branches.byProjectAndNameOr404(project.id, "feature");
        const main = h.deps.services.branches.byProjectAndNameOr404(project.id, "main");
        const lsnSpy = vi.spyOn(h.deps.services.timetravel, "lsnAtTimestamp").mockResolvedValueOnce("0/ABCDEF");
        const createSpy = vi.spyOn(h.deps.services.branches, "create");

        const res = await h.call("create_branch", {
          project: "shop", name: "pitr-fork", parent: "feature", at_timestamp: "2026-07-01T00:00:00Z",
        });

        expect(res.isError).toBeFalsy();
        // resolved against the PARENT's id, never main's.
        expect(lsnSpy).toHaveBeenCalledWith(parent.id, "2026-07-01T00:00:00Z");
        expect(lsnSpy).not.toHaveBeenCalledWith(main.id, expect.anything());
        // the resolved LSN actually reaches branches.create as atLsn.
        expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ atLsn: "0/ABCDEF" }));
      });

      it("the happy-path create passes createdBy: \"mcp\" to branches.create", async () => {
        h = await makeReadToolsHarness();
        await h.call("create_project", { name: "shop" });
        primeRunningAfterStart(h);
        const spy = vi.spyOn(h.deps.services.branches, "create");

        const res = await h.call("create_branch", { project: "shop", name: "agent/try-index" });

        expect(res.isError).toBeFalsy();
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ createdBy: "mcp" }));
      });
    });
  });
});
