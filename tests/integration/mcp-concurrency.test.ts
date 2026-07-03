import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDevdb, type Devdb } from "./helpers/container.js";
import { connect } from "./helpers/pg.js";

const connStr = (text: string) => text.match(/postgresql:\/\/\S+/)![0];

// The product's core promise (spec: "worktree : files :: branch : data" — but for PARALLEL
// agents, not one agent working serially). Task 16's mcp.test.ts already proved CoW isolation and
// the full tool surface end-to-end with a SINGLE session; this test proves the orthogonal claim:
// N agents, each with their OWN MCP session (own `initialize` -> own mcp-session-id, exercising
// the Task 8 session store under real concurrency), can create/write/delete isolated branches
// AT THE SAME TIME with zero interference. That stresses two mechanisms mcp.test.ts never
// touches concurrently: the per-branch BranchQueue lanes (state/queue.ts, Task 1) serializing
// each branch's own create->start->delete sequence, and ComputeManager's single process-wide
// `reservedPorts` Set (compute/manager.ts) arbitrating the SAME port range across DIFFERENT
// branches' concurrent endpoint starts (see allocatePort's reserve-then-probe: it claims each
// candidate into the shared reservedPorts set synchronously, BEFORE its real tryBind() probe's
// await, so two interleaved starts can never be handed the same port — compute/ports.ts).
describe("mcp concurrency (parked §4.6, the product's core promise)", () => {
  let dev: Devdb;
  let bootstrap: Client;
  beforeAll(async () => {
    dev = await startDevdb();
    bootstrap = new Client({ name: "bootstrap", version: "1.0.0" });
    await bootstrap.connect(new StreamableHTTPClientTransport(new URL(`${dev.base}/mcp`)));
  });
  afterAll(async () => {
    await bootstrap?.close();
    await dev?.stop();
  });

  const call0 = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const r = await bootstrap.callTool({ name, arguments: args });
    return (r.content as Array<{ text: string }>)[0].text;
  };

  it("parallel agents create, write, and delete isolated branches without interference", async () => {
    const N = 6;
    await call0("create_project", { name: "load" });

    const runAgent = async (i: number): Promise<void> => {
      // Own Client + own transport => own `initialize` handshake => own mcp-session-id. This is
      // the load-bearing part of the test: N concurrent SESSIONS, not one shared session issuing
      // N concurrent tool calls (which would only exercise the queue lanes, not the session store).
      const client = new Client({ name: `agent-${i}`, version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${dev.base}/mcp`)));
      const t = async (name: string, args: Record<string, unknown>): Promise<string> => {
        const r = await client.callTool({ name, arguments: args });
        return (r.content as Array<{ text: string }>)[0].text;
      };

      try {
        const branchTxt = await t("create_branch", {
          project: "load",
          name: `agent/b${i}`,
          context: { purpose: `p${i}` },
        });
        const pg = await connect(dev, connStr(branchTxt));
        try {
          // Two separate calls, not one semicolon-joined string: pg's parameterized query
          // ($1) goes over the extended/prepared-statement protocol, which the server rejects
          // outright if the query text contains more than one statement ("cannot insert
          // multiple commands into a prepared statement") — this bit the brief's own inline
          // template verbatim; it isn't a case for the DDL to also carry the bind parameter.
          await pg.query("create table m (v int)");
          await pg.query("insert into m values ($1)", [i]);
          // The isolation invariant: agent i must see ONLY its own value, never another
          // concurrently-running agent's write bleeding across branches via a port/lane mixup.
          const v = (await pg.query("select v from m")).rows[0].v;
          expect(v).toBe(i);
        } finally {
          await pg.end();
        }
        await t("delete_branch", { project: "load", branch: `agent/b${i}` });
      } finally {
        await client.close();
      }
    };

    await Promise.all(Array.from({ length: N }, (_, i) => runAgent(i)));

    // Clean concurrent deletes: none of the N agent branches survive, and main + the project
    // itself are unaffected by the churn (list_branches on the bootstrap session — a THIRD,
    // still-open session distinct from every agent's — proves the store tracks sessions
    // independently rather than something getting torn down cross-session).
    const tree = await call0("list_branches", { project: "load" });
    for (let i = 0; i < N; i++) expect(tree).not.toMatch(new RegExp(`agent/b${i}\\b`));
    expect(tree).toMatch(/main/);
  });
});
