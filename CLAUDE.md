@AGENTS.md

## Claude-specific notes

- Superpowers skills are installed in this repo (`.claude/skills/`): use `brainstorming` before creative work, `writing-plans` for phase plans, `subagent-driven-development` for execution, `using-git-worktrees` before implementation work (never implement on `main` directly).
- The review broker is a user-scoped MCP (`mcp__review-broker__*`); its companion skill is `/review-broker`. Always pass absolute `focusFiles` + `repoRoot` when scanning from a worktree, and set `REVIEW_BROKER_DOC` to `<repo>/docs/codebase-review.md`.
- Jordan works hands-on in parallel sessions (IDE + spawned tasks). Expect `main` to move; his uncommitted worktree edits + plan amendment notes are intentional — absorb with disclosure and credit, don't revert.
