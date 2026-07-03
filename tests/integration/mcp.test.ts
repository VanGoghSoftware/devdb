import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDevdb, type Devdb } from "./helpers/container.js";
import { api, connect } from "./helpers/pg.js";

const connStr = (text: string) => text.match(/postgresql:\/\/\S+/)![0];

// handover §8 point 5 / §3 point 5 (get_lsn_by_timestamp future-until-later-commit; timetravel.test.ts's
// same waitForLsnResolvable): kind:"future" only flips to "present" once a LATER commit lands — pure
// wall-clock waiting never resolves it on its own. restore_branch's MCP handler calls
// TimeTravelService.lsnAtTimestamp internally and surfaces its DevdbError(400, "...kind=future...")
// as an isError tool result (see tools.ts's guard()), so polling the pre-existing REST
// GET /api/branches/:id/lsn endpoint (the same one timetravel.test.ts polls) is the deterministic gate
// before calling restore_branch — not a shortcut, the identical mechanism the product already exposes.
async function waitForLsnResolvable(dev: Devdb, branchId: string, isoTimestamp: string): Promise<void> {
  const path = `/api/branches/${branchId}/lsn?timestamp=${encodeURIComponent(isoTimestamp)}`;
  let lastBody = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(`${dev.base}${path}`);
    if (res.status === 200) return;
    lastBody = await res.text();
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`GET ${path} never returned 200 within ~10s of polling — last response body: ${lastBody}`);
}

describe("mcp acceptance flow (spec v1 items 3-4)", () => {
  let dev: Devdb;
  let client: Client;
  beforeAll(async () => {
    dev = await startDevdb();
    client = new Client({ name: "acceptance", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${dev.base}/mcp`)));
  });
  afterAll(async () => {
    await client?.close();
    await dev?.stop();
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const r = await client.callTool({ name, arguments: args });
    return (r.content as Array<{ text: string }>)[0].text;
  };

  it("branches isolate writes from main, show fork context + client, and support reset + restore-as-new-branch", async () => {
    await call("create_project", { name: "shop" });

    // seed main via a real MCP tool call, not a REST shortcut — the connection string comes back
    // embedded in the tool's TEXT response, per the MCP response contract.
    const mainTxt = await call("get_branch", { project: "shop", branch: "main" });
    const main = await connect(dev, connStr(mainTxt));
    await main.query("create table t (id int); insert into t values (1)");

    // agent branch with fork context — create_branch merges the caller-supplied context with the
    // session's own captured clientInfo ({name:"acceptance",...} from the Client constructed above).
    const branchTxt = await call("create_branch", {
      project: "shop",
      name: "agent/mutate",
      context: { git_branch: "feat/x", workdir: "/w", purpose: "destructive test" },
    });
    const branch = await connect(dev, connStr(branchTxt));
    await branch.query("insert into t values (2), (3)");
    expect((await branch.query("select count(*)::int c from t")).rows[0].c).toBe(3);

    // the money property: main is completely unaffected by the branch's destructive writes
    expect((await main.query("select count(*)::int c from t")).rows[0].c).toBe(1);

    // tree shows the fork context AND the captured session client name
    const tree = await call("list_branches", { project: "shop" });
    expect(tree).toMatch(/agent\/mutate/);
    expect(tree).toMatch(/destructive test/);
    expect(tree).toMatch(/acceptance/); // captured client name from the MCP initialize handshake

    // reset_branch stops+swaps agent/mutate's endpoint (TimeTravelService.swapOntoNewTimeline stops
    // the endpoint it "wasRunning" before swapping timelines) — close this branch's own connection
    // BEFORE triggering that, or the backend gets killed out from under an open client (57P01
    // "terminating connection due to administrator command"), an avoidable unhandled rejection.
    await branch.end();

    // reset -> branch matches parent (1 row) again
    const resetTxt = await call("reset_branch", { project: "shop", branch: "agent/mutate" });
    const afterReset = await connect(dev, connStr(resetTxt));
    expect((await afterReset.query("select count(*)::int c from t")).rows[0].c).toBe(1);

    // restore main as a new branch at a pre-mistake timestamp.
    // handover §8 point 5 / §3 point 5: get_lsn_by_timestamp only resolves a target instant once a
    // LATER commit has landed (never on wall-clock waiting alone) — capture the target after letting
    // its own commit durably land (the same fixed WAL-durability gap timetravel.test.ts uses), then
    // issue ANOTHER committed write, then poll the real REST endpoint before calling restore_branch.
    await main.query("insert into t values (7)"); // the point-in-time we'll recover
    await new Promise((r) => setTimeout(r, 3000)); // let WAL land durably behind the target instant
    const restoreTarget = new Date().toISOString();

    await main.query("insert into t values (9)"); // advance the clock so restoreTarget resolves
    const projects = await api<Array<{ id: string; name: string }>>(dev, "GET", "/api/projects");
    const project = projects.find((p) => p.name === "shop")!;
    const branches = await api<Array<{ id: string; name: string }>>(dev, "GET", `/api/projects/${project.id}/branches`);
    const mainBranch = branches.find((b) => b.name === "main")!;
    await waitForLsnResolvable(dev, mainBranch.id, restoreTarget);

    const restoreTxt = await call("restore_branch", {
      project: "shop",
      branch: "main",
      to_timestamp: restoreTarget,
      as_new_branch: "recovered",
    });
    expect(restoreTxt).toMatch(/recovered/);
    const recovered = await connect(dev, connStr(restoreTxt));
    // the recovered branch has the 7-row world (2 rows: seeded 1 + the pre-target insert of 7),
    // NOT the post-target insert of 9 — proving restore-as-new-branch actually recovered the
    // timestamped point, not just created an empty/unrelated branch.
    expect((await recovered.query("select array_agg(id order by id) a from t")).rows[0].a).toEqual([1, 7]);

    await main.end();
    await afterReset.end();
    await recovered.end();
  });
});
