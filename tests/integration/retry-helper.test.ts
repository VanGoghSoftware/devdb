import { describe, expect, it } from "vitest";
import { isTransientConnError, retryOnTransient, withRetryableResource } from "./helpers/retry.js";

// Pure-logic unit test for the connection-teardown retry helper (helpers/retry.ts) — no container,
// no Docker, runs in milliseconds. Exists so the retry/classification logic that hardens the
// integration suite against the compute-SIGTERM-mid-query flake (a restore/reset auto-stops+restarts
// a branch's compute; a fresh connect+query issued right after can race that under machine-level
// resource pressure) has deterministic RED/GREEN coverage of its own, decoupled from the flake it
// guards — which is intermittent and cannot be reproduced on demand.
const noSleep = async (): Promise<void> => {};

describe("isTransientConnError", () => {
  it("matches Postgres/socket connection-teardown signatures", () => {
    // 57P01 sent by a backend as its compute is SIGTERM'd out from under it (the flake's core signal)
    expect(isTransientConnError(new Error("terminating connection due to administrator command"))).toBe(true);
    // node-postgres' error when the server closes the socket with a query in flight
    expect(isTransientConnError(new Error("Connection terminated unexpectedly"))).toBe(true);
    // a just-restarted compute's postmaster rejecting a fresh connect (57P03) — the likeliest shape
    // for a post-restore/reset connect racing the compute's startup
    expect(isTransientConnError(Object.assign(new Error("the database system is starting up"), { code: "57P03" }))).toBe(true);
    expect(isTransientConnError(Object.assign(new Error("the database system is shutting down"), { code: "57P03" }))).toBe(true);
    // matched on .code alone, even when the message carries no teardown phrase
    expect(isTransientConnError(Object.assign(new Error("FATAL: could not receive data"), { code: "57P03" }))).toBe(true);
    // a freshly (re)started compute momentarily not yet accepting connections
    expect(isTransientConnError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54301"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isTransientConnError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    // pg also surfaces the raw SQLSTATE on the error's `code`
    expect(isTransientConnError(Object.assign(new Error("terminating connection ..."), { code: "57P01" }))).toBe(true);
  });

  it("does NOT match SQL-semantic errors or assertion failures (those must still surface)", () => {
    // deliberately narrow: a wrong-timeline restore that drops a table, or a bad row count, is a
    // real product defect — retrying it would mask a bug, not harden a flake.
    expect(isTransientConnError(new Error('relation "t" does not exist'))).toBe(false);
    expect(isTransientConnError(new Error("expected 1 to deeply equal 2"))).toBe(false);
    // a semantic/assertion error whose MESSAGE merely mentions a SQLSTATE number is NOT retriable —
    // codes are matched on .code (exact), never as a message substring, so this can't be masked.
    expect(isTransientConnError(new Error("expected error code 57P03 but the query committed"))).toBe(false);
    expect(isTransientConnError(new Error("assertion failed: found 57P01 in the audit log"))).toBe(false);
    expect(isTransientConnError(null)).toBe(false);
    expect(isTransientConnError(undefined)).toBe(false);
  });
});

describe("retryOnTransient", () => {
  const transient = new Error("Connection terminated unexpectedly");
  const fatal = new Error('relation "t" does not exist');

  it("returns the result without retrying when fn succeeds on the first attempt", async () => {
    let calls = 0;
    const out = await retryOnTransient(async () => { calls++; return "ok"; }, isTransientConnError, { sleep: noSleep });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries a retriable error, then returns once fn succeeds", async () => {
    let calls = 0;
    const out = await retryOnTransient(async () => {
      calls++;
      if (calls < 3) throw transient;
      return "recovered";
    }, isTransientConnError, { sleep: noSleep });
    expect(out).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("does not retry a non-retriable error — surfaces it on the first attempt", async () => {
    let calls = 0;
    await expect(
      retryOnTransient(async () => { calls++; throw fatal; }, isTransientConnError, { sleep: noSleep }),
    ).rejects.toThrow('relation "t" does not exist');
    expect(calls).toBe(1);
  });

  it("throws the last error after exhausting the attempt budget", async () => {
    let calls = 0;
    await expect(
      retryOnTransient(async () => { calls++; throw transient; }, isTransientConnError, { attempts: 4, sleep: noSleep }),
    ).rejects.toThrow("Connection terminated unexpectedly");
    expect(calls).toBe(4);
  });

  it("clamps a nonsensical attempts:0 to a single try instead of throwing undefined", async () => {
    let calls = 0;
    const out = await retryOnTransient(async () => { calls++; return "ok"; }, isTransientConnError, { attempts: 0, sleep: noSleep });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });
});

describe("withRetryableResource", () => {
  const transient = new Error("Connection terminated unexpectedly");
  const fatal = new Error('relation "x" does not exist');

  it("acquires, uses, and releases exactly once on success", async () => {
    const log: string[] = [];
    const out = await withRetryableResource(
      async () => { log.push("acquire"); return { id: 1 }; },
      async (r) => { log.push(`use:${r.id}`); return "ok"; },
      async (r) => { log.push(`release:${r.id}`); },
      isTransientConnError, { sleep: noSleep },
    );
    expect(out).toBe("ok");
    expect(log).toEqual(["acquire", "use:1", "release:1"]);
  });

  it("releases the resource even when use throws, and does NOT retry a non-transient error", async () => {
    const log: string[] = [];
    await expect(withRetryableResource(
      async () => { log.push("acquire"); return { id: 1 }; },
      async () => { log.push("use"); throw fatal; },
      async () => { log.push("release"); },
      isTransientConnError, { sleep: noSleep },
    )).rejects.toThrow('relation "x" does not exist');
    // release ran despite the throw; no re-acquire (fatal error is not retried)
    expect(log).toEqual(["acquire", "use", "release"]);
  });

  it("re-acquires a FRESH resource and releases every one across retried transient failures", async () => {
    const acquired: number[] = [];
    const released: number[] = [];
    let attempt = 0;
    const out = await withRetryableResource(
      async () => { const id = ++attempt; acquired.push(id); return { id }; },
      async (r) => { if (r.id < 3) throw transient; return `done:${r.id}`; },
      async (r) => { released.push(r.id); },
      isTransientConnError, { sleep: noSleep },
    );
    expect(out).toBe("done:3");
    expect(acquired).toEqual([1, 2, 3]); // a brand-new resource each attempt (not reused)
    expect(released).toEqual([1, 2, 3]); // and every acquired resource was released, no leak
  });

  it("a throwing release never replaces the use() error nor mis-drives the retry", async () => {
    // use() throws a NON-retriable error; release() throws a transient-LOOKING one. The use() error
    // must win — propagate the fatal error, do NOT retry on the release's transient shape.
    let uses = 0;
    await expect(withRetryableResource(
      async () => ({ id: 1 }),
      async () => { uses++; throw fatal; },
      async () => { throw new Error("Connection terminated unexpectedly"); },
      isTransientConnError, { sleep: noSleep },
    )).rejects.toThrow('relation "x" does not exist');
    expect(uses).toBe(1); // the release throw did not resurrect the loop
  });

  it("a throwing release is swallowed on the success path (use result still returns)", async () => {
    const out = await withRetryableResource(
      async () => ({ id: 1 }),
      async () => "ok",
      async () => { throw new Error("end failed"); },
      isTransientConnError, { sleep: noSleep },
    );
    expect(out).toBe("ok");
  });
});
