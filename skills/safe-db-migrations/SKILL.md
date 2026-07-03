---
name: safe-db-migrations
description: Use before running a schema migration or destructive SQL against a database - rehearse it on a throwaway devdb branch, verify, then apply to main, with restore_branch as the undo.
---

# Safe DB Migrations

## Overview

Never rehearse a migration on `main`. DevDB branches make a full-fidelity dry run free: fork `main`,
run the migration for real, verify, then apply the same migration to `main` only once the rehearsal
is clean.

All tools below are exposed by the connected `devdb` MCP server, take `project` (the project name)
plus a `branch` name, and are documented in full in the `using-devdb` skill.

## Workflow

1. **Rehearse** on a fresh branch off `main`, taken immediately before you rehearse (so it matches
   `main`'s current state). Use `create_branch` with `project`, `name` (`migration/<slug>`), and fork
   context under `context` (`git_branch`/`workdir`/`purpose`). The response includes a connection
   string — run the migration against it, not against `main`.
2. **Verify** schema + data on the rehearsal branch. If it broke something:
   - `reset_branch` (`project` + `branch`) to discard the changes and return to `main`'s current
     state, then retry the migration; or
   - `delete_branch` (`project` + `branch`) to discard the branch entirely and start over with a new
     `create_branch`.
3. **Apply to `main`** once the rehearsal is clean: run the same migration against `main`'s own
   connection string (`get_branch` with `project` + `branch: "main"` if you need to re-fetch it).
4. **Undo** if a migration on `main` goes wrong: `restore_branch` with `project`, `branch: "main"`,
   `to_timestamp` (ISO-8601, e.g. from before you applied the migration), and `as_new_branch` (a new
   name) to recover `main`'s pre-migration state into a new branch — non-destructive, `main` is
   untouched. Verify the recovered branch, then cut over (e.g. point traffic at its connection
   string, or replay the recovered state onto `main`).

## Other tools

- `get_branch` (`project` + `branch`) — re-fetch a connection string for the rehearsal branch or for
  `main`; restarts the endpoint by default if it's stopped.
- `list_branches` (`project`) — see prior rehearsal branches and their fork context before naming a
  new one.

## Rules

- The rehearsal branch must match `main`'s starting state — branch immediately before rehearsing, not
  hours earlier, or the dry run tests stale schema/data.
- Never run the migration directly against `main`'s connection string until the rehearsal branch has
  verified clean.
- `restore_branch` without `as_new_branch` restores in place, destructively, on the branch you name —
  for undoing a bad migration on `main`, always pass `as_new_branch` so the recovery lands in a new
  branch and `main` itself is untouched until you deliberately cut over.
- Keep `to_timestamp` ISO-8601 with an explicit timezone.
- Clean up rehearsal branches (`delete_branch`) once the migration has landed on `main`.
