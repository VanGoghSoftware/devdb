// Surfaced in the MCP initialize response so agents get the branch-per-task discipline even with
// zero skills installed (refinement spec Decision 3).
export const MCP_INSTRUCTIONS = `DevDB gives each agent an isolated, writable copy of a database — worktree : files :: branch : data.

Workflow:
- Create one branch per task off \`main\`: create_branch with name "agent/<task-slug>" and a fork context
  (git_branch, workdir, purpose). It auto-starts an endpoint and returns a connection string.
- Wire that connection string into your worktree's environment. Work destructively — main is untouched.
- Never share one branch between concurrent agents. Use get_branch to re-fetch a connection string.
- reset_branch to scrap changes and match the parent again; restore_branch to recover a past point.
- delete_branch when the task is done.

Always pass fork context on create_branch so a human can tell parallel agents' branches apart.`;
