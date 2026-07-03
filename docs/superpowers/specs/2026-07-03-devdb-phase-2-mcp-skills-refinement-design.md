# DevDB Phase 2 — MCP Server + Skills: Design Refinement

**Date:** 2026-07-03
**Status:** Approved (Jordan, 2026-07-03)
**Relationship:** Light refinement of the main design spec (`2026-07-02-devdb-design.md`, §MCP server + §Agent skills) and the handover's §4. The main spec stays authoritative for product decisions; this doc records the three product questions that were still open entering phase 2, plus one implementation constraint discovered while grounding them. The engineering-only parked decisions (handover §4 items 1–6) are plan territory and are **not** restated here.

## Context

Phase 2 delivers the product's original pitch: agents create / use / reset / restore branches without human help, and shipped skills establish the branch-per-task workflow. The spec settled almost everything (tool names, fork context, response ergonomics). Three product questions and one implementation constraint remained; all four are resolved below.

---

## Decision 1 — MCP auth posture: unauthenticated, with a rebinding guard

`/mcp` ships **unauthenticated** — spec decision #6 (localhost trust) stands, preserving the one-line `claude mcp add --transport http devdb http://localhost:4400/mcp` registration UX. We add defense-in-depth that is explicitly *not* auth:

- **DNS-rebinding protection** on the `/mcp` transport (the MCP SDK's `StreamableHTTPServerTransport` rebinding-protection option): validate the `Host` and `Origin` request headers against an allowlist. Default allowlist: `localhost`, `127.0.0.1`, `host.docker.internal` (with and without the `:4400` port). This satisfies the MCP spec's MUST on Origin validation and blocks a malicious web page from driving branch-mutating tools via a browser DNS-rebind.
- **Configurable:** `DEVDB_MCP_ALLOWED_HOSTS` / `DEVDB_MCP_ALLOWED_ORIGINS` (comma-separated) extend the allowlist for devcontainer / custom-hostname setups.
- **Compose binding:** publish both ranges on the loopback interface — `127.0.0.1:4400:4400` and `127.0.0.1:54300-54339:54300-54339` — so the shipped default matches the spec's stated "bind 127.0.0.1" posture (the endpoints already carry SCRAM; this aligns the published surface with the trust model). Deliberate wider exposure becomes a documented README step.
- REST (`/api`) and UI keep their phase-1 behavior; the guard is scoped to `/mcp`.

**Rejected:** a bearer token — it breaks the frictionless registration the spec optimizes for and diverges from the unauthenticated REST/UI on the same port. Reconsider only if remote exposure becomes a product goal (a non-goal today).

## Decision 2 — Import/export tools: omit until phase 4 (do not stub)

Phase 2 registers **10 tools**: `list_projects`, `create_project`, `list_branches`, `create_branch`, `get_branch`, `stop_endpoint`, `delete_branch`, `reset_branch`, `restore_branch`, `get_status`.

`import_database`, `export_branch`, and `get_job` are **omitted**, not stubbed:

- Advertising always-failing tools burns schema tokens in every agent's context and invites retry loops — bad MCP citizenship.
- Tool lists are dynamic; the three tools appear when phase 4 ships. Because the server is session-stateful (Decision 4), it advertises the `tools.listChanged` capability and can emit `notifications/tools/list_changed` to live sessions the moment the phase-4 surface registers — no reconnect required.
- The **importing-databases** skill defers to phase 4 alongside its tools.

## Decision 3 — Skill distribution: docs + the MCP `instructions` field

Phase 2 ships two skills in `skills/`: **using-devdb** and **safe-db-migrations** (superpowers-conventioned, referencing MCP tool names exactly). Two delivery channels, no new packaging infrastructure:

1. **Repo + docs:** README quickstart shows copy/symlink install into `~/.claude/skills` (global) or a project's `.claude/skills` (per-repo).
2. **MCP `instructions` field:** the `initialize` response carries a condensed branch-per-task discipline — branch `agent/<task-slug>` off `main`; always pass fork context; wire the connection string into the worktree env; never share a branch between concurrent agents; delete on completion. Every connected agent gets the core workflow even with zero skills installed, and it is agent-vendor-neutral (any MCP client surfaces server instructions).

**Parked / declined:** a Claude Code plugin (manifest + marketplace) is the slickest Claude-specific UX but adds a packaging surface and helps only Claude clients — parked as a **phase-5** platform candidate layered on top of this. A bespoke daemon-served skill channel (`curl | sh` smell) is declined.

## Decision 4 — Constraint: the MCP server must be session-stateful

The fork-context amendment requires capturing `client {name, version}` from the `initialize` handshake and attaching it to branches created later in the *same* session. The SDK's **stateless** Streamable-HTTP mode builds a fresh server per request, so a later `create_branch` reaches an instance that never saw `initialize` — client info would always be empty. Phase 2 therefore runs the MCP server **stateful**:

- Session lifecycle keyed by the `mcp-session-id` header: `initialize` mints a session and its per-session server instance holding `clientInfo`; subsequent requests resolve to that instance.
- `DELETE /mcp` (SDK convention) tears a session down; an **idle-eviction sweep** reaps abandoned agent sessions so they don't accumulate (agents frequently drop connections without a clean close).
- Statefulness is also the prerequisite for the `tools/list_changed` behavior in Decision 2.

This is an implementation-shape decision surfaced here because it changes the MCP module's contract; the plan carries it as an early task.

> **SDK-shape note:** the exact `@modelcontextprotocol/sdk` option names (rebinding-protection flag, `allowedHosts`/`allowedOrigins`, `sessionIdGenerator`, server `instructions`, `sendToolListChanged`) are pinned against the SDK version chosen when the plan adds the dependency — the same discipline the project applies to engine API shapes (oracle rule). The decisions above are transport-behavior contracts, not literal API signatures.

---

## What this refinement does NOT change

- **Tool names, arguments, and the fork-context schema** — as specified in the main spec (§MCP server, incl. the 2026-07-03 fork-context amendment).
- **Response ergonomics** — every success response opens with a context line naming project/branch (plus parent, for forks), includes the connection string when relevant and a next-step hint; every error names its remediation; timestamps are ISO-8601 with explicit timezone. (Spec §MCP server.)
- **The 6 engineering parked decisions** (lane capability tokens; DTO redaction + genericized 409s; metrics-based compute readiness; process-group kill; structured logging; MCP-concurrency integration test) — resolved in the implementation plan as early/prerequisite tasks, per handover §4. They are prerequisites for the MCP surface, not post-hoc cleanup.

## Acceptance (unchanged from handover §4 sketch)

`claude mcp add … /mcp` → agent `create_branch` (with fork context) → gets connection string → destructive writes on its branch; `main` unaffected; `list_branches` shows the tree with fork context; `reset_branch` → branch matches parent again; `restore_branch --as-new-branch` recovers a pre-mistake timestamp. At least one skill exercised end-to-end by a scripted MCP-SDK client flow inside the testcontainers harness, plus a concurrency test (parallel create/use/delete across branches).
