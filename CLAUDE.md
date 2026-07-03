@AGENTS.md

## Claude-specific notes

- Superpowers skills are installed in this repo (`.claude/skills/`): use `brainstorming` before creative work, `writing-plans` for phase plans, `subagent-driven-development` for execution, `using-git-worktrees` before implementation work (never implement on `main` directly).
- The review broker is a user-scoped MCP (`mcp__review-broker__*`); its companion skill is `/review-broker`. Always pass absolute `focusFiles` + `repoRoot` when scanning from a worktree, and set `REVIEW_BROKER_DOC` to `<repo>/docs/codebase-review.md`.
- Jordan works hands-on in parallel sessions (IDE + spawned tasks). Expect `main` to move; his uncommitted worktree edits + plan amendment notes are intentional — absorb with disclosure and credit, don't revert.

## Model escalation (default session model is Opus)

When you hit any of the following, STOP and ask Jordan to switch the session to **Fable** (model picker / `/model`) before proceeding — state in one sentence why the escalation is warranted; don't muddle through on the default:

- architecture-level or cross-cutting design choices (phase designs, changes to the queue-lane/concurrency model, storage or durability semantics, engine-interaction contracts);
- critical or resistant bugs — races, data loss/corruption risk, anything that survives a first systematic-debugging pass;
- whole-branch/final reviews and phase-plan writing.

For a *bounded* heavy-reasoning subtask, prefer dispatching a subagent with `model: "fable"` instead of switching the whole session (the SDD final review already mandates the most capable model). Routine implementation, fixes with complete specs, and mechanical reviews stay on the session default.
