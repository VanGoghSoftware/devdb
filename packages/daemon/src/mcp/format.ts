// MCP response contract (spec §MCP server, sdk-notes.md's brief-verified `CallToolResult` shape):
// every success response is actionable text that opens with a context line naming the project
// and branch acted on (plus parent, for forks), includes the connection string when relevant and
// a next-step hint; every error names its remediation. Timestamps are ISO-8601.
//
// `ToolResult` is a structural SUBSET of the SDK's own `CallToolResult` (types.ts's
// CallToolResultSchema: `content` defaults to `[]` and the schema is `z.core.$loose` at the
// OUTER object level — extra/optional fields like `structuredContent`/`_meta` are tolerated at
// runtime) — so every value built here satisfies the SDK's real return type for a tool callback
// without needing to import or depend on it. The `[key: string]: unknown` index signature below
// is required ONLY to satisfy tsc's structural check against that `$loose`-inferred type (a loose
// zod object's inferred TS type carries an index signature); it has no runtime effect — every
// value this module actually constructs still has exactly `content`/`isError`, nothing else.
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });

export const errorResult = (remediation: string): ToolResult => ({
  content: [{ type: "text", text: remediation }],
  isError: true,
});

export const nowIso = (): string => new Date().toISOString();

export function contextLine(a: { project: string; branch?: string; parent?: string }): string {
  let s = `[devdb] project "${a.project}"`;
  if (a.branch) s += ` · branch "${a.branch}"`;
  if (a.parent) s += ` (forked from "${a.parent}")`;
  return s;
}
