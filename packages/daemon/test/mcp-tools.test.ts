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
    //
    // Dynamic-pg-builds Task 1 widened PgVersionSchema from a fixed 14–17 union to
    // `z.number().int().gte(14)` (packages/shared/src/index.ts) — no upper bound, so a pulled
    // v18 build validates. That means the schema layer can no longer reject 18; only the floor
    // (13 and below, non-integers) is a schema-level reject. Runtime "is this major actually
    // installed" validation moved to ProjectsService.create() in Task 8 (DevdbError 400 "not
    // installed — installed majors: …", gated on a `builds` dep) — see
    // docs/superpowers/plans/2026-07-04-devdb-dynamic-pg-builds.md Task 8. The harness now wires a
    // real `builds` fake (baked majors 14-17, see helpers/mcp-harness.ts's fakes()) into every
    // service it constructs, mirroring production (index.ts always wires a real BuildRegistry) —
    // so 18 now REJECTS here, retiring this describe block's former "accepts 18" assertion.
    describe("pgVersion coverage", () => {
      it.each([14, 15, 16, 17])("accepts pgVersion %d", async (pgVersion) => {
        h = await makeReadToolsHarness();
        const res = await h.call("create_project", { name: `shop-${pgVersion}`, pgVersion });
        expect(res.isError).toBeFalsy();
        expect(firstText(res)).toContain(`pg${pgVersion}`);
      });

      // Task 8: the installedMajors guard now rejects a schema-valid-but-not-installed major.
      // Retires this describe block's former "accepts pgVersion 18" assertion (correct for Task
      // 1's world, where no `builds` dep — and therefore no guard — existed anywhere yet).
      it("rejects pgVersion 18 with the installed-majors guard (registry-availability guard, Task 8)", async () => {
        h = await makeReadToolsHarness();
        const res = await h.call("create_project", { name: "shop-18", pgVersion: 18 });
        expect(res.isError).toBe(true);
        expect(firstText(res)).toMatch(/not installed — installed majors: 14, 15, 16, 17/);
      });

      it("rejects pgVersion 13 with a caller-actionable message", async () => {
        h = await makeReadToolsHarness();
        const res = await h.call("create_project", { name: "shop", pgVersion: 13 });
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
      expect(firstText(res)).toMatch(/postgresql:\/\/.+@127\.0\.0\.1:54301\/postgres/);
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
      expect(firstText(res)).toMatch(/postgresql:\/\/.+@127\.0\.0\.1:54301\/postgres/);
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

  // Task 11: the four branch-mutation tools. Same primeRunningAfterStart() fixture as
  // create_branch above (statusOf flips "stopped" once then "running" post-start, portOf returns
  // a concrete port) — reused here so stop_endpoint/reset_branch/restore_branch's connection-
  // string-bearing assertions have a real "running" endpoint to observe, not the fakes() default
  // (statusOf always "stopped").
  function primeRunningAfterStart(h: McpToolsHarness, port = 54301): void {
    vi.mocked(h.engineFakes.computes.statusOf).mockReturnValueOnce("stopped").mockReturnValue("running");
    vi.mocked(h.engineFakes.computes.portOf).mockReturnValue(port);
  }

  describe("stop_endpoint", () => {
    it("stops a running endpoint and reports it stopped, with a next-step hint naming get_branch", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);
      await h.call("create_branch", { project: "shop", name: "feature" });
      // primeRunningAfterStart's "running" latch (consumed once as "stopped" by create_branch's
      // own auto-start) is still in effect here — a real ComputeManager.statusOf() would report
      // "stopped" once EndpointsService.stopLocked's own computes.stop() call has actually torn
      // the compute down; this fake needs an explicit re-latch to reflect that same transition
      // (mirrors endpoints-service.test.ts's "stop calls computes.stop and returns the branch as
      // stopped" fixture, which never re-primes "running" in the first place).
      vi.mocked(h.engineFakes.computes.statusOf).mockReturnValue("stopped");

      const res = await h.call("stop_endpoint", { project: "shop", branch: "feature" });

      expect(res.isError).toBeFalsy();
      expect(h.engineFakes.computes.stop).toHaveBeenCalled();
      expect(firstLine(firstText(res))).toMatch(/project "shop"/);
      expect(firstLine(firstText(res))).toMatch(/branch "feature"/);
      expect(firstText(res)).toMatch(/stopped/);
      expect(firstText(res)).toMatch(/get_branch/);
    });

    it("on a missing project returns an actionable error naming list_projects", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("stop_endpoint", { project: "nope", branch: "main" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_projects/);
    });

    it("on a missing branch returns an actionable error naming list_branches", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("stop_endpoint", { project: "shop", branch: "nope" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_branches/);
    });
  });

  describe("delete_branch", () => {
    it("deletes a childless branch and reports it", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      await h.call("create_branch", { project: "shop", name: "scratch" });

      const res = await h.call("delete_branch", { project: "shop", branch: "scratch" });

      expect(res.isError).toBeFalsy();
      expect(firstLine(firstText(res))).toMatch(/project "shop"/);
      expect(firstLine(firstText(res))).toMatch(/branch "scratch"/);
      expect(firstText(res)).toMatch(/deleted/);

      const list = await h.call("list_branches", { project: "shop" });
      expect(firstText(list)).not.toMatch(/scratch/);
    });

    // Fix 3 (task-11 fix wave, fold): the response contract requires every SUCCESS to name a
    // next step, same as every other mutation tool (create_branch/reset_branch/stop_endpoint all
    // already do) — delete_branch's success previously stopped at "deleted." with nothing after.
    it("a successful delete includes a next-step hint", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      await h.call("create_branch", { project: "shop", name: "scratch" });

      const res = await h.call("delete_branch", { project: "shop", branch: "scratch" });

      expect(res.isError).toBeFalsy();
      expect(firstText(res).toLowerCase()).toMatch(/next:/);
      expect(firstText(res)).toMatch(/list_branches|create_branch/);
    });

    // The brief's headline scenario: a branch with children must refuse deletion and surface the
    // service's own "delete them first" remediation (BranchesService.delete, services/branches.ts)
    // verbatim through the MCP guard() error path, not a generic/opaque failure.
    it("surfaces the children-exist remediation", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      await h.call("create_branch", { project: "shop", name: "parent" });
      await h.call("create_branch", { project: "shop", name: "child", parent: "parent" });

      const res = await h.call("delete_branch", { project: "shop", branch: "parent" });

      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/delete them first/);
      expect(firstText(res)).toMatch(/child/);
    });

    it("on a missing project returns an actionable error naming list_projects", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("delete_branch", { project: "nope", branch: "main" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_projects/);
    });

    it("on a missing branch returns an actionable error naming list_branches", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("delete_branch", { project: "shop", branch: "nope" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_branches/);
    });
  });

  describe("reset_branch", () => {
    it("resets a branch to its parent's current state and reports the match, including a connection string when running", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);
      await h.call("create_branch", { project: "shop", name: "dev" });
      // resetToParent's swap re-starts the endpoint on the swapped identity only if it was
      // running beforehand (services/timetravel.ts's swapOntoNewTimeline) — statusOf's mock is
      // already latched to "running" by primeRunningAfterStart, so the post-swap detail() call
      // observes a live endpoint and portOf still returns the primed port.

      const res = await h.call("reset_branch", { project: "shop", branch: "dev" });

      expect(res.isError).toBeFalsy();
      expect(firstLine(firstText(res))).toMatch(/project "shop"/);
      expect(firstText(res)).toMatch(/reset to parent/);
      expect(firstText(res)).toMatch(/postgresql:\/\/.+@127\.0\.0\.1:54301\/postgres/);
    });

    it("refuses on a branch with no parent (main) and surfaces the remediation", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("reset_branch", { project: "shop", branch: "main" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/no parent/);
    });

    // Fix 2 (task-11 fix wave, fold): "branch X has no parent" alone names the failure but not a
    // next step — an agent hitting this on "main" (the only branch that can ever have no parent —
    // only project.create() ever creates a parentless branch, per renderBranchTree's own doc
    // comment above) has no way to self-correct from that phrase alone. Asserts the actual
    // remediation TEXT (not just the bare "no parent" fact the prior test already covers) points
    // at either resetting a child instead, or restore_branch as the past-point alternative.
    it("the no-parent error on main names an actionable remediation (reset a child, or restore_branch instead)", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("reset_branch", { project: "shop", branch: "main" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/restore_branch/);
    });

    it("refuses when children exist and surfaces the remediation", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      await h.call("create_branch", { project: "shop", name: "dev" });
      await h.call("create_branch", { project: "shop", name: "grandchild", parent: "dev" });
      const res = await h.call("reset_branch", { project: "shop", branch: "dev" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/delete them first/);
    });

    it("on a missing project returns an actionable error naming list_projects", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("reset_branch", { project: "nope", branch: "main" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_projects/);
    });

    it("on a missing branch returns an actionable error naming list_branches", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("reset_branch", { project: "shop", branch: "nope" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_branches/);
    });
  });

  describe("restore_branch", () => {
    it("with as_new_branch: recovers non-destructively into a NEW branch and returns its connection string", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);

      const res = await h.call("restore_branch", {
        project: "shop", branch: "main", to_timestamp: "2026-07-01T00:00:00Z", as_new_branch: "recovered",
      });

      expect(res.isError).toBeFalsy();
      expect(firstLine(firstText(res))).toMatch(/project "shop"/);
      expect(firstLine(firstText(res))).toMatch(/branch "recovered"/);
      expect(firstLine(firstText(res))).toMatch(/forked from "main"/);
      expect(firstText(res)).toMatch(/postgresql:\/\/.+@127\.0\.0\.1:54301\/postgres/);
      expect(firstText(res).toLowerCase()).toMatch(/next:/);

      // the SOURCE branch ("main") must be untouched — this is the non-destructive path.
      const list = await h.call("list_branches", { project: "shop" });
      expect(firstText(list)).toMatch(/recovered/);
      expect(firstText(list)).toMatch(/main/);
    });

    it("with as_new_branch: passes projectId/sourceBranchId/name/isoTimestamp/createdBy through to branchAtTimestamp, folding the session client into context", async () => {
      h = await makeReadToolsHarness({ clientInfo: { name: "claude-code", version: "9.9" } });
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);
      const project = h.deps.services.projects.byNameOr404("shop");
      const main = h.deps.services.branches.byProjectAndNameOr404(project.id, "main");
      const spy = vi.spyOn(h.deps.services.timetravel, "branchAtTimestamp");

      const res = await h.call("restore_branch", {
        project: "shop", branch: "main", to_timestamp: "2026-07-01T00:00:00Z", as_new_branch: "recovered",
        context: { purpose: "recover deleted rows" },
      });

      expect(res.isError).toBeFalsy();
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        projectId: project.id, sourceBranchId: main.id, name: "recovered",
        isoTimestamp: "2026-07-01T00:00:00Z", createdBy: "mcp",
        context: expect.objectContaining({
          purpose: "recover deleted rows",
          client: { name: "claude-code", version: "9.9" },
        }),
      }));
    });

    // Mirrors create_branch's Fix 1 (task-10 fix wave): the new branch is already durably created
    // by the time ensureRunning() runs — a thrown auto-start failure must NOT be allowed to look
    // like an opaque/generic error, and the branch must NOT be deleted (it's restartable via
    // get_branch). Reuses whatever shared helper create_branch's partial-success handling factors
    // into (see tools.ts) rather than duplicating the behavior ad hoc.
    it("as_new_branch's auto-start failure reports a partial success naming the new branch + endpoint_error + recovery, and does NOT delete it", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      vi.mocked(h.engineFakes.computes.start).mockRejectedValueOnce(new Error("compute_ctl exited before ready"));

      const res = await h.call("restore_branch", {
        project: "shop", branch: "main", to_timestamp: "2026-07-01T00:00:00Z", as_new_branch: "recovered",
      });

      expect(res.isError).toBe(true);
      const body = firstText(res);
      expect(firstLine(body)).toMatch(/project "shop"/);
      expect(firstLine(body)).toMatch(/branch "recovered"/);
      expect(body.toLowerCase()).toMatch(/created/);
      expect(body).toMatch(/compute_ctl exited before ready/);
      expect(body).toMatch(/get_branch/);
      expect(body).toMatch(/delete_branch/);

      // the branch STILL EXISTS — proving restore_branch did not compensate/delete it away.
      const list = await h.call("list_branches", { project: "shop" });
      expect(firstText(list)).toMatch(/recovered/);
    });

    it("without as_new_branch: restores in place, says the endpoint was auto-stopped and restarted, and includes a connection string", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);

      const res = await h.call("restore_branch", {
        project: "shop", branch: "main", to_timestamp: "2026-07-01T00:00:00Z",
      });

      expect(res.isError).toBeFalsy();
      expect(firstLine(firstText(res))).toMatch(/project "shop"/);
      expect(firstText(res)).toMatch(/restored in place/);
      expect(firstText(res)).toMatch(/2026-07-01T00:00:00Z/);
      expect(firstText(res).toLowerCase()).toMatch(/auto-stopped|auto-restart|restarted/);
      expect(firstText(res)).toMatch(/postgresql:\/\/.+@127\.0\.0\.1:54301\/postgres/);

      // Identity swap (services/timetravel.ts's swapOntoNewTimeline, oracle-derived): "main" is
      // now a FRESH row at the resolved point, and the pre-restore row survives archived under a
      // "main_pitr_archived_<ts>" name — same shape timetravel.test.ts's own restoreInPlace test
      // asserts at the service level. Both are real rows and both legitimately appear in
      // list_branches; the point of THIS test is that "main" itself is still there under its
      // original name (an in-place restore, not a rename-away or a new sibling branch).
      const list = await h.call("list_branches", { project: "shop" });
      expect(firstText(list)).toMatch(/\bmain\b/);
      expect(firstText(list)).toMatch(/main_pitr_archived_/);
    });

    it("on a missing project returns an actionable error naming list_projects", async () => {
      h = await makeReadToolsHarness();
      const res = await h.call("restore_branch", { project: "nope", branch: "main", to_timestamp: "2026-07-01T00:00:00Z" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_projects/);
    });

    it("on a missing branch returns an actionable error naming list_branches", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const res = await h.call("restore_branch", { project: "shop", branch: "nope", to_timestamp: "2026-07-01T00:00:00Z" });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toMatch(/list_branches/);
    });

    // Fix 1 (task-11 fix wave, CRITICAL — destructive footgun): the pre-fix handler branched on
    // `if (as_new_branch)` — plain truthiness — while the schema accepted a bare
    // `z.string().optional()`, so `as_new_branch: ""` (a caller who clearly INTENDED the
    // non-destructive new-branch path but supplied an empty name) satisfied the schema, then fell
    // through the falsy check straight into the DESTRUCTIVE in-place restore of the SOURCE branch
    // — silent data loss, no error, nothing to signal the caller got the wrong path. The fix moves
    // the rejection to the SCHEMA boundary (`z.string().trim().min(1).optional()`) so this fails
    // BEFORE either restore path's handler body ever runs — asserted here by spying on BOTH
    // `restoreInPlace` (the destructive path that must never fire) and `branchAtTimestamp` (the
    // new-branch path, which also must never fire — an empty name isn't a valid new-branch name
    // either) and proving neither was called, not just that the response looks like an error.
    it("as_new_branch: \"\" (empty string) fails validation and does NOT fall through to the destructive in-place restore", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const restoreInPlaceSpy = vi.spyOn(h.deps.services.timetravel, "restoreInPlace");
      const branchAtTimestampSpy = vi.spyOn(h.deps.services.timetravel, "branchAtTimestamp");

      const res = await h.call("restore_branch", {
        project: "shop", branch: "main", to_timestamp: "2026-07-01T00:00:00Z", as_new_branch: "",
      });

      expect(res.isError).toBe(true);
      // An actionable validation error — not a silent success and not an opaque crash.
      expect(firstText(res).toLowerCase()).toMatch(/as_new_branch|empty|string/);

      // The crux: NEITHER restore path's service method ran. Proves this failed at the validation
      // boundary, before any side effect — not merely that the destructive path's OWN internal
      // logic happened to bail out after already starting work.
      expect(restoreInPlaceSpy).not.toHaveBeenCalled();
      expect(branchAtTimestampSpy).not.toHaveBeenCalled();

      // The source branch is provably untouched: still named "main", no archived sibling exists.
      const list = await h.call("list_branches", { project: "shop" });
      expect(firstText(list)).toMatch(/\bmain\b/);
      expect(firstText(list)).not.toMatch(/_pitr_archived_/);
    });

    // Fix 1's "whitespace-only" companion — `.trim()` in the schema means a name of only spaces is
    // ALSO rejected AT THE SCHEMA BOUNDARY (not silently trimmed down to "" and treated as
    // present-with-empty-string, which would just move the footgun rather than closing it, and not
    // merely failing LATER for an unrelated reason — e.g. slugify("   ") happens to produce an
    // empty slug that some downstream validation might also reject, which would make this test
    // pass for the wrong reason). Spies on BOTH service methods, same rigor as the crux empty-
    // string test above, so a regression that let whitespace slip past the schema and only get
    // caught deeper in branchAtTimestamp's own call chain is still caught as a real failure here.
    it("as_new_branch: \"   \" (whitespace only) also fails validation at the schema boundary, not just a bare empty string", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      const restoreInPlaceSpy = vi.spyOn(h.deps.services.timetravel, "restoreInPlace");
      const branchAtTimestampSpy = vi.spyOn(h.deps.services.timetravel, "branchAtTimestamp");

      const res = await h.call("restore_branch", {
        project: "shop", branch: "main", to_timestamp: "2026-07-01T00:00:00Z", as_new_branch: "   ",
      });

      expect(res.isError).toBe(true);
      expect(restoreInPlaceSpy).not.toHaveBeenCalled();
      expect(branchAtTimestampSpy).not.toHaveBeenCalled();
    });

    // Fix 4 (task-11 fix wave, fold): the in-place path unconditionally claimed "endpoint
    // auto-stopped and restarted" — but swapOntoNewTimeline (services/timetravel.ts) only restarts
    // the endpoint on the swapped identity `if (wasRunning)` beforehand. A branch with NO running
    // endpoint at restore time comes back STOPPED (no connectionString) — the old message would
    // falsely claim a restart that never happened. The default harness fixture never calls
    // create_branch/primeRunningAfterStart for "main" in this describe block's OTHER in-place test
    // (which explicitly primes a running endpoint), so THIS test deliberately does NOT prime one —
    // "main" starts genuinely stopped (fakes()'s own computes.statusOf default), exercising the
    // false branch of the DTO-conditional message.
    it("without as_new_branch, on a branch with NO running endpoint: does not falsely claim a restart, and points at get_branch", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      // No primeRunningAfterStart(h) call — main's endpoint is stopped (fakes() default:
      // computes.statusOf always returns "stopped"), so swapOntoNewTimeline's `wasRunning` is
      // false and it never calls startLocked on the swapped identity.

      const res = await h.call("restore_branch", {
        project: "shop", branch: "main", to_timestamp: "2026-07-01T00:00:00Z",
      });

      expect(res.isError).toBeFalsy();
      const body = firstText(res);
      expect(body).toMatch(/restored/);
      // The false claim this fix removes: must NOT say the endpoint was restarted/auto-stopped-
      // and-restarted when no endpoint was ever running to restart.
      expect(body.toLowerCase()).not.toMatch(/restarted/);
      expect(body.toLowerCase()).not.toMatch(/auto-stopped and restarted/);
      // No connection string — the restored branch is genuinely stopped.
      expect(body).not.toMatch(/postgresql:\/\//);
      // Must still tell the caller how to get a connection: get_branch starts it.
      expect(body).toMatch(/get_branch/);
    });

    // Fix 4's positive companion: re-asserts (alongside the existing "restores in place..." test
    // above) that when the endpoint WAS running, the message DOES claim the restart — proving the
    // conditional actually renders both branches of the DTO check, not just suppressing the claim
    // unconditionally.
    it("without as_new_branch, on a branch WITH a running endpoint: does claim the restart and includes a connection string", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);

      const res = await h.call("restore_branch", {
        project: "shop", branch: "main", to_timestamp: "2026-07-01T00:00:00Z",
      });

      expect(res.isError).toBeFalsy();
      const body = firstText(res);
      expect(body.toLowerCase()).toMatch(/restarted/);
      expect(body).toMatch(/postgresql:\/\/.+@127\.0\.0\.1:54301\/postgres/);
    });

    // Fix 5 (task-11 fix wave, fold): pins the SWAPPED-LIVE identity explicitly. The existing
    // in-place test (above) already asserts a connection string appears and that BOTH "main" and
    // the archived name appear somewhere in list_branches — but doesn't pin WHICH line the
    // response's own FIRST line names. A regression that accidentally returned the ARCHIVED row's
    // detail (e.g. wrong id passed to branches.detail after the swap) could still pass a loose
    // "contains main somewhere" check if "main" happens to substring-match part of the archived
    // name's prefix. This asserts the response's own context line (not just list_branches' output)
    // names exactly "main" and does NOT include the archived suffix.
    it("without as_new_branch: the response's own context line names the LIVE \"main\" identity, never the archived one", async () => {
      h = await makeReadToolsHarness();
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);

      const res = await h.call("restore_branch", {
        project: "shop", branch: "main", to_timestamp: "2026-07-01T00:00:00Z",
      });

      expect(res.isError).toBeFalsy();
      const line = firstLine(firstText(res));
      expect(line).toMatch(/branch "main"/);
      expect(line).not.toMatch(/_pitr_archived_/);
    });

    // Fix 6 (task-11 fix wave, fold): restore_branch's as_new_branch path reuses create_branch's
    // exact fork-context-merge spoof-safety property (`{ ...(context ?? {}), client: ctx.clientInfo() }`)
    // but had no adversarial coverage of its own — mirrors create_branch's own "drops a
    // caller-supplied context.client" test (above) so a regression specific to THIS callsite (e.g.
    // someone copies the merge but gets the spread order backwards here while leaving
    // create_branch's correct) is still caught.
    it("as_new_branch: drops a caller-supplied context.client (schema has no such key) — the SERVER-captured session client always wins", async () => {
      h = await makeReadToolsHarness({ clientInfo: { name: "claude-code", version: "9.9" } });
      await h.call("create_project", { name: "shop" });
      primeRunningAfterStart(h);

      const res = await h.call("restore_branch", {
        project: "shop", branch: "main", to_timestamp: "2026-07-01T00:00:00Z", as_new_branch: "recovered",
        // `client` isn't part of the declared context schema — passed via an untyped bag to mirror
        // an adversarial caller who ignores the declared schema, same discipline as
        // create_branch's own spoof-safety test.
        context: { purpose: "legit reason", client: { name: "FAKE", version: "0" } } as Record<string, unknown>,
      });
      expect(res.isError).toBeFalsy();

      const list = await h.call("list_branches", { project: "shop" });
      const body = firstText(list);
      expect(body).toMatch(/claude-code/); // the server-captured session client
      expect(body).not.toMatch(/FAKE/); // never the caller-spoofed one
    });
  });

  // Task 11: the four pg-builds MCP tools — list_pg_builds/check_pg_updates/pull_pg_build/
  // activate_pg_build — so an agent can self-serve a missing major or a newer minor without a
  // human touching the REST API. NO MCP delete tool exists (spec: infra-destructive stays human).
  describe("pg-builds tools", () => {
    // Minimal PgBuildRow fixture builder — mirrors the real interface (state/repos.ts) so
    // list_pg_builds' rendering logic is exercised against realistic row shapes, not a
    // hand-wavy partial.
    function fakeRow(a: Partial<import("../src/state/repos.js").PgBuildRow> & { id: string; major: number }): import("../src/state/repos.js").PgBuildRow {
      return {
        minor: null, source: "downloaded", releaseTag: "latest", imageDigest: "", path: `/data/pg/v${a.major}/x`,
        status: "ready", active: false, sizeBytes: null, error: null, createdAt: "2026-07-01T00:00:00.000Z",
        ...a,
      };
    }

    describe("list_pg_builds", () => {
      it("renders an active line, per-build sublines, and does not open with a project context line (no project scope)", async () => {
        h = await makeReadToolsHarness();
        vi.mocked(h.pgBuildFakes.registry.installedMajors).mockReturnValue([16]);
        vi.mocked(h.pgBuildFakes.registry.list).mockReturnValue([
          fakeRow({ id: "baked-v16", major: 16, minor: 9, source: "baked", releaseTag: "baked", active: false, status: "ready" }),
          fakeRow({ id: "dl-16-abc", major: 16, minor: 10, source: "downloaded", releaseTag: "9124", active: true, status: "ready" }),
        ]);
        vi.mocked(h.pgBuildFakes.registry.degradedMajors).mockReturnValue([]);

        const res = await h.call("list_pg_builds", {});

        expect(res.isError).toBeFalsy();
        const body = firstText(res);
        // active line names the major, active version, source, and release tag
        expect(body).toMatch(/PG 16.*active 16\.10/);
        expect(body).toMatch(/downloaded/);
        expect(body).toMatch(/9124/);
        // the non-active baked row renders as a subline
        expect(body).toMatch(/\[ready\] 16\.9/);
        expect(body).toMatch(/baked/);
        // no project/branch scope — this tool has none, so it must not open with contextLine()'s
        // project-naming shape the way every project-scoped tool does.
        expect(firstLine(body)).not.toMatch(/project "/);
      });

      // Fix round 1 (review of Task 11 commit cfec31c, P3): the pre-fix rendering derived its
      // per-major set from `registry.installedMajors()` — which only returns majors with a READY
      // row (BuildRegistry.installedMajors(), registry.ts) — while `pull_pg_build`'s own progress
      // text tells agents to "poll list_pg_builds" for status. A pull of a brand-new major (no
      // prior ready row for it at all) is invisible in that poll loop the entire time it's
      // downloading/validating, and stays invisible forever if it ends failed — the self-service
      // "add a major" flow silently looks like it never started. Fixture: PG 18 has ONLY a
      // `downloading` row and a `failed` row — deliberately NOT in `installedMajors()` (mocked to
      // `[16]` only, mirroring the real registry's contract of ready-only majors) but present in
      // `registry.list()` (the DISTINCT-majors-across-ALL-rows source `list_pg_builds` must derive
      // its set from instead). Both in-flight statuses must render, proving the tool no longer
      // filters by installedMajors() before deciding which majors to even look at.
      it("shows a major that has NO ready build yet (only downloading/failed rows) — not just majors in installedMajors()", async () => {
        h = await makeReadToolsHarness();
        vi.mocked(h.pgBuildFakes.registry.installedMajors).mockReturnValue([16]);
        vi.mocked(h.pgBuildFakes.registry.list).mockReturnValue([
          fakeRow({ id: "baked-v16", major: 16, minor: 9, source: "baked", releaseTag: "baked", active: true, status: "ready" }),
          fakeRow({ id: "dl-18-pulling", major: 18, minor: null, source: "downloaded", releaseTag: "latest", active: false, status: "downloading" }),
          fakeRow({ id: "dl-18-bad", major: 18, minor: null, source: "downloaded", releaseTag: "9050", active: false, status: "failed", error: "gate: extension smoke test failed" }),
        ]);
        vi.mocked(h.pgBuildFakes.registry.degradedMajors).mockReturnValue([]);

        const res = await h.call("list_pg_builds", {});

        expect(res.isError).toBeFalsy();
        const body = firstText(res);
        // PG 18 appears at all (the RED-failing assertion pre-fix: absent entirely).
        expect(body).toMatch(/PG 18/);
        // No ready/active row for 18 — a clear "no active build yet" line, not a false "active ..."
        // claim and not silently omitted.
        expect(body).toMatch(/PG 18.*no active build/i);
        // BOTH in-flight rows render as sublines — downloading and failed, not just ready ones.
        expect(body).toMatch(/\[downloading\]/);
        expect(body).toMatch(/\[failed\] release 9050/);
        expect(body).toMatch(/gate: extension smoke test failed/);
        // PG 16 (the installedMajors()-covered major) still renders normally alongside it.
        expect(body).toMatch(/PG 16.*active 16\.9/);
      });

      it("renders a failed build's subline with its error", async () => {
        h = await makeReadToolsHarness();
        vi.mocked(h.pgBuildFakes.registry.installedMajors).mockReturnValue([16]);
        vi.mocked(h.pgBuildFakes.registry.list).mockReturnValue([
          fakeRow({ id: "baked-v16", major: 16, minor: 9, source: "baked", releaseTag: "baked", active: true, status: "ready" }),
          fakeRow({ id: "dl-16-bad", major: 16, minor: null, source: "downloaded", releaseTag: "9101", active: false, status: "failed", error: "gate: extension smoke test failed" }),
        ]);
        vi.mocked(h.pgBuildFakes.registry.degradedMajors).mockReturnValue([]);

        const res = await h.call("list_pg_builds", {});

        expect(res.isError).toBeFalsy();
        const body = firstText(res);
        expect(body).toMatch(/\[failed\] release 9101/);
        expect(body).toMatch(/gate: extension smoke test failed/);
      });

      it("prefixes a degraded major with a warning line", async () => {
        h = await makeReadToolsHarness();
        vi.mocked(h.pgBuildFakes.registry.installedMajors).mockReturnValue([16]);
        vi.mocked(h.pgBuildFakes.registry.list).mockReturnValue([
          fakeRow({ id: "baked-v16", major: 16, minor: 9, source: "baked", releaseTag: "baked", active: true, status: "ready" }),
        ]);
        vi.mocked(h.pgBuildFakes.registry.degradedMajors).mockReturnValue([16]);

        const res = await h.call("list_pg_builds", {});

        expect(res.isError).toBeFalsy();
        const body = firstText(res);
        expect(body).toMatch(/⚠.*PG 16.*BELOW.*last-run/i);
        expect(body).toMatch(/re-pull/i);
      });

      it("trails with an updates line when a prior check found news", async () => {
        h = await makeReadToolsHarness();
        vi.mocked(h.pgBuildFakes.registry.installedMajors).mockReturnValue([16]);
        vi.mocked(h.pgBuildFakes.registry.list).mockReturnValue([
          fakeRow({ id: "baked-v16", major: 16, minor: 9, source: "baked", releaseTag: "baked", active: true, status: "ready" }),
        ]);
        vi.mocked(h.pgBuildFakes.registry.degradedMajors).mockReturnValue([]);
        vi.mocked(h.pgBuildFakes.provisioner.updateAvailableFor).mockImplementation(
          (major: number) => (major === 16 ? "latest@ab12cd34ef56" : null),
        );

        const res = await h.call("list_pg_builds", {});

        expect(res.isError).toBeFalsy();
        const body = firstText(res);
        expect(body).toMatch(/updates: PG 16 → latest@ab12cd34ef56/);
      });

      it("with no installed majors, says so and hints at pull_pg_build", async () => {
        h = await makeReadToolsHarness();
        vi.mocked(h.pgBuildFakes.registry.installedMajors).mockReturnValue([]);
        vi.mocked(h.pgBuildFakes.registry.list).mockReturnValue([]);
        vi.mocked(h.pgBuildFakes.registry.degradedMajors).mockReturnValue([]);

        const res = await h.call("list_pg_builds", {});

        expect(res.isError).toBeFalsy();
        expect(firstText(res).toLowerCase()).toMatch(/pull_pg_build/);
      });
    });

    describe("check_pg_updates", () => {
      it("runs the provisioner check over the given majors and renders the isNew map", async () => {
        h = await makeReadToolsHarness();
        const checkSpy = vi.mocked(h.pgBuildFakes.provisioner.check).mockResolvedValue({
          "16": { tag: "latest", digest: "sha256:" + "a".repeat(64), isNew: true, at: "2026-07-04T00:00:00.000Z" },
          "17": { tag: "latest", digest: "sha256:" + "b".repeat(64), isNew: false, at: "2026-07-04T00:00:00.000Z" },
        } as Awaited<ReturnType<typeof h.pgBuildFakes.provisioner.check>>);

        const res = await h.call("check_pg_updates", { majors: [16, 17] });

        expect(res.isError).toBeFalsy();
        expect(checkSpy).toHaveBeenCalledWith([16, 17]);
        const body = firstText(res);
        expect(body).toMatch(/16/);
        expect(body).toMatch(/17/);
        expect(body.toLowerCase()).toMatch(/new|update/);
      });

      it("defaults majors to the currently-installed set when omitted", async () => {
        h = await makeReadToolsHarness();
        vi.mocked(h.pgBuildFakes.registry.installedMajors).mockReturnValue([14, 15]);
        const checkSpy = vi.mocked(h.pgBuildFakes.provisioner.check).mockResolvedValue({});

        const res = await h.call("check_pg_updates", {});

        expect(res.isError).toBeFalsy();
        expect(checkSpy).toHaveBeenCalledWith([14, 15]);
      });
    });

    describe("pull_pg_build", () => {
      // provisioner.pull()'s OWN contract (provisioner.ts) is to resolve fast — it synchronously
      // inserts the `downloading` row, then fires the real extract/fixup/validate/auto-activate
      // pipeline WITHOUT awaiting it (`void this.runPipeline(...)`) before returning `{buildId}`.
      // The tool's job is simply to await that already-fast promise and return its text — NOT to
      // additionally poll registry.list() for a "ready" status before replying. Modeling
      // "never awaits the pipeline" at the MCP-tool layer means: the tool call resolves as soon
      // as the (fast) pull() promise resolves, without the tool itself reaching for
      // registry.list()/registry.byId() to check whether the row has advanced past
      // "downloading" — asserted here by never priming registry.list() at all and confirming the
      // tool doesn't need it.
      it("starts the pull and returns immediately with the poll instruction (does not consult registry.list for the row's progress)", async () => {
        h = await makeReadToolsHarness();
        const pullSpy = vi.mocked(h.pgBuildFakes.provisioner.pull).mockResolvedValue({ buildId: "build-abc" });
        const listSpy = vi.mocked(h.pgBuildFakes.registry.list);

        const res = await h.call("pull_pg_build", { major: 16 });

        expect(res.isError).toBeFalsy();
        expect(pullSpy).toHaveBeenCalledWith(expect.objectContaining({ major: 16 }));
        expect(listSpy).not.toHaveBeenCalled(); // never consults progress — pull() itself is the whole call
        expect(firstText(res)).toMatch(/build-abc/);
      });

      it("passes an optional tag through to the provisioner", async () => {
        h = await makeReadToolsHarness();
        const pullSpy = vi.mocked(h.pgBuildFakes.provisioner.pull).mockResolvedValue({ buildId: "build-123" });

        const res = await h.call("pull_pg_build", { major: 16, tag: "9124" });

        expect(res.isError).toBeFalsy();
        expect(pullSpy).toHaveBeenCalledWith({ major: 16, tag: "9124" });
        const body = firstText(res);
        expect(body).toMatch(/build-123/);
        expect(body).toMatch(/pull started/i);
        expect(body).toMatch(/list_pg_builds/);
        expect(body).toMatch(/downloading.*validating.*ready|status/i);
      });

      // Enhancement (Sonnet Minor, review of Task 11 commit cfec31c, fold): the progress line
      // previously named ONLY the poll instruction (list_pg_builds) — this pins the added mention
      // of GET /api/events as the non-polling alternative (Provisioner.publish() emits a
      // `pg_builds` SSE event on every pipeline transition, provisioner.ts), alongside the
      // pre-existing poll instruction (which must still be present, not replaced by this addition).
      it("mentions GET /api/events as a non-polling alternative to list_pg_builds, alongside the poll instruction", async () => {
        h = await makeReadToolsHarness();
        vi.mocked(h.pgBuildFakes.provisioner.pull).mockResolvedValue({ buildId: "build-abc" });

        const res = await h.call("pull_pg_build", { major: 16 });

        expect(res.isError).toBeFalsy();
        const body = firstText(res);
        expect(body).toMatch(/list_pg_builds/); // poll instruction still present
        expect(body).toMatch(/api\/events/);
        expect(body).toMatch(/pg_builds/); // names the actual event type, not just the route
      });

      it("surfaces the provisioner's concurrent-pull 409 as an actionable error", async () => {
        h = await makeReadToolsHarness();
        const { DevdbError } = await import("../src/services/errors.js");
        vi.mocked(h.pgBuildFakes.provisioner.pull).mockRejectedValue(
          new DevdbError(409, "a build pull is already in progress"),
        );

        const res = await h.call("pull_pg_build", { major: 16 });

        expect(res.isError).toBe(true);
        expect(firstText(res)).toMatch(/already in progress/);
      });
    });

    describe("activate_pg_build", () => {
      // FIX-8 (Jordan's decision, 2026-07-05): MCP must REFUSE downgrades outright — an agent may
      // not unilaterally roll a branch back to an older minor. Unlike the pre-fix behavior (auto-
      // consenting with a "rollback" warning), a below-high-water target is now never activated at
      // all: no call to provisioner.activate, high-water/active pointer untouched, and the result
      // redirects the agent to the human-consent path (web UI Settings card confirm dialog, or
      // REST POST /api/pg-builds/:id/activate {consented:true}).
      it("refuses a downgrade below the last-run high-water — does not call provisioner.activate, and points at the human-consent path", async () => {
        h = await makeReadToolsHarness();
        const row = fakeRow({ id: "dl-16-old", major: 16, minor: 9, source: "downloaded", releaseTag: "8464", status: "ready", active: false });
        vi.mocked(h.pgBuildFakes.registry.list).mockReturnValue([row]);
        // Simulates registry's own last-run high-water via state.pgMajors — 16.10 has already run,
        // so activating 16.9 is a downgrade.
        h.deps.state.pgMajors.recordRun(16, 10);
        const activateSpy = vi.mocked(h.pgBuildFakes.provisioner.activate);

        const res = await h.call("activate_pg_build", { major: 16, version: "16.9" });

        expect(res.isError).toBe(true);
        const body = firstText(res);
        // Names the downgrade and the high-water it falls below.
        expect(body.toLowerCase()).toMatch(/downgrade/);
        expect(body).toMatch(/16\.10/); // the last-run minor it would fall below
        // Redirects to the human-consent path — never implies the agent can just retry over MCP.
        expect(body).toMatch(/consented.*true|consent/i);
        expect(body.toLowerCase()).toMatch(/web ui|settings/);
        expect(body).toMatch(/POST \/api\/pg-builds\/:id\/activate|\/api\/pg-builds/);
        // Never activated: no provisioner call at all, so the high-water can't have been lowered
        // and the active pointer can't have moved — this is the whole point of the fix.
        expect(activateSpy).not.toHaveBeenCalled();
      });

      it("activates the resolved ready row by major+version when it is NOT a downgrade (no consent needed/passed)", async () => {
        h = await makeReadToolsHarness();
        const row = fakeRow({ id: "dl-16-old", major: 16, minor: 9, source: "downloaded", releaseTag: "8464", status: "ready", active: false });
        vi.mocked(h.pgBuildFakes.registry.list).mockReturnValue([row]);
        const activateSpy = vi.mocked(h.pgBuildFakes.provisioner.activate).mockResolvedValue({ ...row, active: true });

        const res = await h.call("activate_pg_build", { major: 16, version: "16.9" });

        expect(res.isError).toBeFalsy();
        // No {consented:true} auto-consent — the MCP path never auto-consents, downgrade or not.
        expect(activateSpy).toHaveBeenCalledWith("dl-16-old");
        expect(firstText(res)).toMatch(/activated 16\.9/);
      });

      it("still succeeds when activating AT OR ABOVE the high-water mark (not a downgrade)", async () => {
        h = await makeReadToolsHarness();
        const row = fakeRow({ id: "dl-16-new", major: 16, minor: 10, source: "downloaded", releaseTag: "9124", status: "ready", active: false });
        vi.mocked(h.pgBuildFakes.registry.list).mockReturnValue([row]);
        h.deps.state.pgMajors.recordRun(16, 9);
        const activateSpy = vi.mocked(h.pgBuildFakes.provisioner.activate).mockResolvedValue({ ...row, active: true });

        const res = await h.call("activate_pg_build", { major: 16, version: "16.10" });

        expect(res.isError).toBeFalsy();
        expect(activateSpy).toHaveBeenCalledWith("dl-16-new");
        expect(firstText(res)).toMatch(/activated 16\.10/);
        expect(firstText(res).toLowerCase()).not.toMatch(/downgrade|refused/);
      });

      it("unknown version -> errorResult listing available ready versions for that major", async () => {
        h = await makeReadToolsHarness();
        vi.mocked(h.pgBuildFakes.registry.list).mockReturnValue([
          fakeRow({ id: "baked-v16", major: 16, minor: 9, source: "baked", releaseTag: "baked", status: "ready", active: true }),
          fakeRow({ id: "dl-16-new", major: 16, minor: 10, source: "downloaded", releaseTag: "9124", status: "ready", active: false }),
          fakeRow({ id: "dl-16-bad", major: 16, minor: null, source: "downloaded", releaseTag: "9101", status: "failed", active: false }),
        ]);

        const res = await h.call("activate_pg_build", { major: 16, version: "16.99" });

        expect(res.isError).toBe(true);
        const body = firstText(res);
        expect(body).toMatch(/16\.99/);
        // lists the available READY versions (9/10), never the failed row (no minor/not ready).
        expect(body).toMatch(/16\.9/);
        expect(body).toMatch(/16\.10/);
        expect(h.pgBuildFakes.provisioner.activate).not.toHaveBeenCalled();
      });
    });
  });
});
