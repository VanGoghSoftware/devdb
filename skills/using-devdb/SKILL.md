---
name: using-devdb
description: Use when starting a task that will touch a database - gives each agent an isolated writable branch (worktree : files :: branch : data) via the devdb MCP server, mirroring git-worktree discipline.
---

# Using DevDB

## Overview

DevDB branches are to data what git worktrees are to code: an instant, isolated, writable copy you
work in destructively and throw away. One branch per task. Never share a branch between concurrent agents.

All tools below are exposed by the connected `devdb` MCP server. `get_status` confirms it's reachable;
`list_projects` shows what's available.

## Workflow

1. **Branch off `main`** with `create_branch`, passing `project` (the project name), `name`
   (`agent/<task-slug>`), and ALWAYS fork context under `context`:
   - `git_branch`: `git branch --show-current`
   - `workdir`: your worktree path (`$PWD`)
   - `purpose`: one line describing the task
   The tool auto-starts an endpoint and returns a connection string in the response text.
2. **Wire the connection string** into your worktree's environment (e.g. `DATABASE_URL`).
3. **Work destructively.** `main` is untouched. Re-fetch a connection string any time with
   `get_branch` (`project` + `branch`) — it restarts the endpoint by default if it's stopped.
4. **Scrap and retry** with `reset_branch` (`project` + `branch`) to discard changes and return to
   the parent's current state, if you need a clean slate.
5. **Clean up** with `delete_branch` (`project` + `branch`) when the task completes. Fails if the
   branch has children — delete those first.

## Other tools

- `list_branches` (`project`) — the branch tree for a project: status, creator, fork context, and
  parent ancestry. Use before `create_branch` to avoid name collisions or pick a non-`main` parent.
- `stop_endpoint` (`project` + `branch`) — stop a branch's endpoint to free its port; `get_branch`
  restarts it.
- `restore_branch` (`project` + `branch` + `to_timestamp`) — time-travel to a past ISO-8601
  timestamp. Pass `as_new_branch` (a name) to recover non-destructively into a new branch
  (recommended); omit it for a destructive in-place restore of the source branch.
- `create_project` (`name`, optional `pgVersion`) — only if the project you need doesn't exist yet;
  each project is a separate database universe with its own auto-created `main` branch.

## Rules

- One branch per task; never point two concurrent agents at the same branch.
- Always pass fork context (`git_branch`/`workdir`/`purpose`) on `create_branch` — it's how a human
  tells parallel agents' branches apart in the dashboard, and how you can too via `list_branches`.
- Stop endpoints you no longer need (`stop_endpoint`) to free ports; `get_branch` restarts them.
- If `create_branch` reports the branch was created but its endpoint failed to start, don't retry
  with another `create_branch` call (you'll hit a duplicate-name error) — call `get_branch` to retry
  the endpoint, or `delete_branch` to discard.
