import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startMock = vi.fn();
const stopMock = vi.fn(async () => {});
vi.mock("../src/engine/process.js", () => ({
  ManagedProcess: vi.fn((opts: unknown) => ({
    start: startMock,
    stop: stopMock,
    state: "stopped",
    pid: null,
    recentLines: () => [],
    __opts: opts,
  })),
}));

// rm is the only fs call stop() retries (compute-dir removal races the orphaned-postgres
// shutdown — see reapOrphanedPostgres/stop() in src/compute/manager.ts), so it is the only
// one mocked; everything else (including reapOrphanedPostgres's /proc readdir/readFile)
// passes through to the real module. The default implementation (restored in beforeEach) is
// the real rm, so tests that don't care about the race exercise real deletion.
const rmMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: rmMock };
});
const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

import { loadConfig } from "../src/config.js";
import { newHexId } from "../src/engine/ids.js";
import { ComputeManager } from "../src/compute/manager.js";
import { ManagedProcess } from "../src/engine/process.js";
import type { waitComputeReady } from "../src/compute/readiness.js";
import type { BranchRow } from "../src/state/repos.js";
import type { Logger } from "../src/logging/logger.js";

const ManagedProcessMock = vi.mocked(ManagedProcess);

function freshCfg(extraEnv: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "devdb-manager-test-"));
  return loadConfig({
    DEVDB_DATA_DIR: dataDir,
    NEON_BINARIES_DIR: "/usr/local/share/neon/bin",
    PG_INSTALL_DIR: "/usr/local/share/neon/pg_install",
    ...extraEnv,
  });
}

// Task 4: ComputeManager now takes a Logger as its second constructor arg (compensation/cleanup
// console.error sites in reapOrphanedPostgres/removeComputeDir route through it) — a typed fake,
// not a cast. None of the existing tests in this file assert against it; they only need a valid
// Logger shape so `new ComputeManager(cfg, fakeLogger())` typechecks.
function fakeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
}

// Task 5: ComputeManager's 3rd (optional) constructor arg injects waitComputeReady — the real
// implementation polls `fetch` against 127.0.0.1:<metricsPort>/metrics, which must never run
// inside a unit test (no live compute_ctl exists here). This fake resolves immediately,
// preserving every existing test's assumption that manager.start() settles as soon as the
// (mocked) ManagedProcess.start() does, without needing to touch any of their assertions.
function fakeWaitReady(): typeof waitComputeReady {
  return vi.fn(async () => {});
}

function fakeBranch(overrides: Partial<BranchRow> = {}): BranchRow {
  return {
    id: newHexId(),
    projectId: newHexId(),
    parentBranchId: null,
    name: "main",
    slug: "acme-main",
    timelineId: newHexId(),
    password: "pw",
    stickyPort: null,
    endpointStatus: "stopped",
    endpointError: null,
    importStatus: "none",
    importError: null,
    createdBy: "api",
    context: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ComputeManager", () => {
  beforeEach(() => {
    startMock.mockReset();
    stopMock.mockReset();
    stopMock.mockImplementation(async () => {});
    rmMock.mockReset();
    rmMock.mockImplementation(realFs.rm);
    ManagedProcessMock.mockClear();
  });

  it("start() constructs ManagedProcess with the oracle launch contract and writes config files", async () => {
    startMock.mockResolvedValueOnce(undefined);
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();

    const { port } = await manager.start({ branch, pgVersion: 17 });

    expect(ManagedProcessMock).toHaveBeenCalledTimes(1);
    const opts = ManagedProcessMock.mock.calls[0]![0] as {
      bin: string; args: string[]; env: Record<string, string>;
      readyNeedle: string; readyTimeoutMs: number;
      onLine: (line: string, stream: "stdout" | "stderr") => void;
    };
    expect(opts.bin).toBe(join(cfg.neonBinDir, "compute_ctl"));
    expect(opts.env).toEqual({});
    expect(opts.readyNeedle).toBe("listening on IPv4 address");
    expect(opts.readyTimeoutMs).toBe(50_000);

    // Recover the temp dir compute_ctl was launched with, to assert byte-exact arg order.
    const computesDir = join(cfg.dataDir, "computes");
    const children = await readdir(computesDir);
    expect(children).toHaveLength(1);
    const dir = join(computesDir, children[0]!);

    expect(opts.args).toEqual([
      "--pgdata", join(dir, "pg_data"),
      "--pgbin", join(cfg.pgInstallDir, "v17", "bin", "postgres"),
      "--compute-id", `compute-${branch.timelineId}`,
      "--connstr", `postgresql://cloud_admin@localhost:${port}/postgres`,
      "--config", join(dir, "config.json"),
      "--external-http-port", String(opts.args[opts.args.indexOf("--external-http-port") + 1]),
      "--internal-http-port", String(opts.args[opts.args.indexOf("--internal-http-port") + 1]),
    ]);

    // Both HTTP ports are per-compute allocations from the 40000-40999 range and must be
    // distinct: leaving --internal-http-port unset means every compute defaults to 3081 and
    // concurrent computes silently collide on the internal server.
    const externalHttpPort = Number(opts.args[opts.args.indexOf("--external-http-port") + 1]);
    const internalHttpPort = Number(opts.args[opts.args.indexOf("--internal-http-port") + 1]);
    for (const p of [externalHttpPort, internalHttpPort]) {
      expect(p).toBeGreaterThanOrEqual(40000);
      expect(p).toBeLessThanOrEqual(40999);
    }
    expect(internalHttpPort).not.toBe(externalHttpPort);
    expect(internalHttpPort).not.toBe(port);

    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(existsSync(join(dir, "pg_hba.conf"))).toBe(true);
    const configRaw = await readFile(join(dir, "config.json"), "utf8");
    expect(() => JSON.parse(configRaw)).not.toThrow();
    const hbaRaw = await readFile(join(dir, "pg_hba.conf"), "utf8");
    expect(hbaRaw.length).toBeGreaterThan(0);
  });

  it("throws on a double-start for the same branch while the first is still unresolved", async () => {
    let releaseFirstStart!: () => void;
    startMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseFirstStart = resolve; }),
    );
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();

    const firstStart = manager.start({ branch, pgVersion: 17 });

    // The map slot is reserved synchronously before the first await inside start(), but the
    // first call still needs to run its own setup (port alloc, dir/file writes) before it
    // reaches ManagedProcess.start(). Wait for that so this assertion exercises the real
    // concurrent-in-flight case, not a race against the first call's own microtasks.
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));

    await expect(manager.start({ branch, pgVersion: 17 })).rejects.toThrow(/already/);

    releaseFirstStart();
    await firstStart;
  });

  it("cleans up the map entry, temp dir, and reserved ports when the launch fails", async () => {
    startMock.mockRejectedValueOnce(new Error("compute_ctl exploded"));
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();

    await expect(manager.start({ branch, pgVersion: 17 })).rejects.toThrow("compute_ctl exploded");

    expect(manager.statusOf(branch.id)).toBe("stopped");
    expect(manager.portOf(branch.id)).toBeNull();

    const computesDir = join(cfg.dataDir, "computes");
    const children = await readdir(computesDir).catch(() => []);
    expect(children).toHaveLength(0);

    // Ports must have been released, or a fresh start (also on this same branch) would throw
    // PortExhaustedError/hang re-binding a still-reserved port instead of proceeding normally.
    startMock.mockResolvedValueOnce(undefined);
    await expect(manager.start({ branch, pgVersion: 17 })).resolves.toEqual({ port: expect.any(Number) });
  });

  // start()'s failure cleanup shares stop()'s reap+rm discipline (removeComputeDir): a launch
  // that dies mid-start (e.g. the readiness timeout SIGKILLing compute_ctl) orphans a live
  // postgres exactly like stop() does, so the failure-path rm races the same still-live writer.
  // The first rm fails ENOTEMPTY with a straggler written behind the walk; the retry (real rm)
  // must clear it, and the caller must see the ORIGINAL launch error, not the rm error.
  it("start() failure cleanup retries reap+rm on ENOTEMPTY and still throws the launch error", async () => {
    startMock.mockRejectedValueOnce(new Error("compute_ctl not ready within 50000ms"));
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();

    let dirSeen = "";
    rmMock.mockImplementationOnce(async (target: string) => {
      dirSeen = target;
      await mkdir(join(target, "pg_data"), { recursive: true });
      await writeFile(join(target, "pg_data", "straggler.tmp"), "written behind the rm walk");
      throw Object.assign(
        new Error(`ENOTEMPTY: directory not empty, rmdir '${join(target, "pg_data")}'`),
        { code: "ENOTEMPTY" },
      );
    });

    await expect(manager.start({ branch, pgVersion: 17 })).rejects.toThrow("compute_ctl not ready within 50000ms");

    expect(rmMock).toHaveBeenCalledTimes(2);
    expect(dirSeen).not.toBe("");
    expect(existsSync(dirSeen)).toBe(false);
    expect(manager.statusOf(branch.id)).toBe("stopped");

    startMock.mockResolvedValueOnce(undefined);
    await expect(manager.start({ branch, pgVersion: 17 })).resolves.toEqual({ port: expect.any(Number) });
  });

  // The two hazards the old inline failure-path rm (no try/catch) had beyond the ENOTEMPTY race
  // itself: an rm throw REPLACED the original launch error, and skipped the map delete after it —
  // a stale entry that made every later start() for the branch throw "already ..." until the
  // daemon restarted. Persistent rm failure is the sharpest probe for both: the caller must
  // still see the launch error, and the branch must restart cleanly on the SAME single port.
  it("start() failure cleanup never masks the launch error when rm fails persistently, and the branch stays restartable", async () => {
    startMock.mockRejectedValueOnce(new Error("compute_ctl exploded"));
    const cfg = freshCfg({ DEVDB_PORT_RANGE: "54332-54332" });
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();

    rmMock.mockImplementation(async () => {
      throw Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" });
    });

    await expect(manager.start({ branch, pgVersion: 17 })).rejects.toThrow("compute_ctl exploded");
    expect(rmMock).toHaveBeenCalledTimes(2); // bounded: first attempt + exactly one retry
    expect(manager.statusOf(branch.id)).toBe("stopped");
    expect(manager.portOf(branch.id)).toBeNull(); // a stale map entry would still report 54332

    const computesDir = join(cfg.dataDir, "computes");
    const children = await readdir(computesDir);
    expect(children).toHaveLength(1); // accepted trade-off: dir leaks rather than masking the error

    rmMock.mockReset();
    rmMock.mockImplementation(realFs.rm);
    startMock.mockResolvedValueOnce(undefined);
    // Same branch, single-port range: this resolves only if the failed start released BOTH the
    // map entry (else "already ...") and the reserved port (else PortExhaustedError).
    await expect(manager.start({ branch, pgVersion: 17 })).resolves.toEqual({ port: 54332 });
  });

  // Fix 1 (review): `onLine` supplied to start()'s args must be registered at map-reservation
  // time — before the first await — so it captures every line printed DURING the launch itself,
  // not just once start() has already resolved. Drives the exact in-flight pattern the
  // "throws on a double-start" test above uses (an unresolved startMock) so this exercises a
  // real "launch is still in progress" window, not a race against microtasks.
  it("onLine passed to start() receives lines emitted BEFORE the launch resolves (readiness)", async () => {
    let releaseStart!: () => void;
    startMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseStart = resolve; }),
    );
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();
    const received: string[] = [];

    const startPromise = manager.start({ branch, pgVersion: 17, onLine: (line) => received.push(line) });

    // Wait for the ManagedProcess constructor call (setup — port alloc, dir/file writes — has
    // completed) so the fanout closure passed to ManagedProcess's `onLine` opt actually exists,
    // then drive it directly to simulate compute_ctl printing output while still starting
    // (unresolved startMock == "not yet ready").
    await vi.waitFor(() => expect(ManagedProcessMock).toHaveBeenCalledTimes(1));
    const opts = ManagedProcessMock.mock.calls[0]![0] as { onLine: (line: string, stream: "stdout" | "stderr") => void };
    opts.onLine("compute_ctl: starting up", "stdout");
    expect(received).toEqual(["compute_ctl: starting up"]);

    releaseStart();
    await startPromise;
  });

  // Fix 1 (review): the specific failure-path counterpart to the test above — a launch that
  // FAILS must still have surfaced its output to the caller's onLine before the rejection, since
  // that output (compute_ctl's last lines before it exited) is exactly what explains WHY the
  // launch failed. Previously EndpointsService only subscribed via computes.onLine() AFTER
  // computes.start() resolved — which a rejected start() never does — so this class of output
  // never reached the logs channel at all.
  it("onLine passed to start() receives lines emitted before a launch FAILURE", async () => {
    let rejectStart!: (e: Error) => void;
    startMock.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectStart = reject; }),
    );
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();
    const received: string[] = [];

    const startPromise = manager.start({ branch, pgVersion: 17, onLine: (line) => received.push(line) });

    await vi.waitFor(() => expect(ManagedProcessMock).toHaveBeenCalledTimes(1));
    const opts = ManagedProcessMock.mock.calls[0]![0] as { onLine: (line: string, stream: "stdout" | "stderr") => void };
    opts.onLine("compute_ctl: fatal: could not bind port", "stderr");
    rejectStart(new Error("compute_ctl exited before ready"));

    await expect(startPromise).rejects.toThrow("compute_ctl exited before ready");
    expect(received).toEqual(["compute_ctl: fatal: could not bind port"]);
  });

  it("reports 'stopping' status while stop() is in flight, then 'stopped' with the dir removed", async () => {
    startMock.mockResolvedValueOnce(undefined);
    let releaseStop!: () => void;
    stopMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseStop = resolve; }),
    );
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();
    await manager.start({ branch, pgVersion: 17 });

    const computesDir = join(cfg.dataDir, "computes");
    const childrenBefore = await readdir(computesDir);
    expect(childrenBefore).toHaveLength(1);
    const dir = join(computesDir, childrenBefore[0]!);

    const stopPromise = manager.stop(branch.id);
    expect(manager.statusOf(branch.id)).toBe("stopping");

    releaseStop();
    await stopPromise;

    expect(manager.statusOf(branch.id)).toBe("stopped");
    expect(existsSync(dir)).toBe(false);
  });

  // Unit-level counterpart of the Task 15 live repro: the recursive rm can lose the race with a
  // still-live orphaned postgres and fail ENOTEMPTY on the final rmdir. stop()'s catch retries
  // reap+rm exactly once — this drives that path at the fs layer (reapOrphanedPostgres itself
  // no-ops here: no /proc on macOS, no cmdline matching the tmpdir path on Linux CI).
  it("stop() retries reap+rm once when pg_data is repopulated behind the first rm (ENOTEMPTY)", async () => {
    startMock.mockResolvedValueOnce(undefined);
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();
    await manager.start({ branch, pgVersion: 17 });

    const computesDir = join(cfg.dataDir, "computes");
    const children = await readdir(computesDir);
    const dir = join(computesDir, children[0]!);

    // First attempt: postgres wrote into pg_data behind rm's tree walk, and the rmdir failed
    // the way node reports it. The straggler file left behind proves the retry re-walks the
    // tree rather than repeating a doomed bare rmdir.
    rmMock.mockImplementationOnce(async () => {
      await mkdir(join(dir, "pg_data"), { recursive: true });
      await writeFile(join(dir, "pg_data", "straggler.tmp"), "written behind the rm walk");
      throw Object.assign(
        new Error(`ENOTEMPTY: directory not empty, rmdir '${join(dir, "pg_data")}'`),
        { code: "ENOTEMPTY" },
      );
    });

    await manager.stop(branch.id);

    expect(rmMock).toHaveBeenCalledTimes(2);
    expect(existsSync(dir)).toBe(false);
    expect(manager.statusOf(branch.id)).toBe("stopped");
  });

  it("stop() never rethrows rm failures, bounds the retry at one, and still releases the ports", async () => {
    startMock.mockResolvedValueOnce(undefined);
    // Single-port range: if the failing stop() below leaked the reserved endpoint port, the
    // restart at the end would have nowhere to allocate and throw PortExhaustedError instead
    // of reusing it.
    const cfg = freshCfg({ DEVDB_PORT_RANGE: "54331-54331" });
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();
    await expect(manager.start({ branch, pgVersion: 17 })).resolves.toEqual({ port: 54331 });
    const computesDir = join(cfg.dataDir, "computes");
    const [child] = await readdir(computesDir);
    const dir = join(computesDir, child!);

    rmMock.mockImplementation(async () => {
      throw Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" });
    });

    // The live repro surfaced this as a spurious stop 500 — rm failures must stay inside
    // stop() (logged loud, dir accepted as leaked) or the throw would skip the port release
    // running after it inside the same finally.
    await expect(manager.stop(branch.id)).resolves.toBeUndefined();
    expect(rmMock).toHaveBeenCalledTimes(2);
    expect(manager.statusOf(branch.id)).toBe("stopped");
    expect(existsSync(dir)).toBe(true); // the accepted trade-off: dir leaks rather than 500s

    rmMock.mockReset();
    rmMock.mockImplementation(realFs.rm);
    startMock.mockResolvedValueOnce(undefined);
    await expect(manager.start({ branch, pgVersion: 17 })).resolves.toEqual({ port: 54331 });
  });

  it("isolates onLine listeners: a throwing listener does not prevent later listeners from receiving the line", async () => {
    startMock.mockResolvedValueOnce(undefined);
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();
    await manager.start({ branch, pgVersion: 17 });

    const opts = ManagedProcessMock.mock.calls[0]![0] as { onLine: (line: string, stream: "stdout" | "stderr") => void };

    const secondReceived: string[] = [];
    manager.onLine(branch.id, () => { throw new Error("boom"); });
    manager.onLine(branch.id, (line) => secondReceived.push(line));

    expect(() => opts.onLine("hello world", "stdout")).not.toThrow();
    expect(secondReceived).toEqual(["hello world"]);
  });

  // Fix 1 (review, regression guard): the exact first-start SCRAM race this task exists to
  // close. ManagedProcess.start() resolving flips proc.state to "running" (the readiness NEEDLE
  // firing) strictly BEFORE waitReady's structural gate (apply_spec/SCRAM commit) resolves — the
  // whole reason Task 5 added waitReady in the first place. A statusOf() that reads proc.state
  // directly during this window hands a concurrent BranchesService.detail() caller a "running"
  // status (and therefore a connection string) for a compute that has not finished authenticating
  // yet. `waitReady` here is a manually-controlled deferred promise (not fakeWaitReady()'s
  // auto-resolving stub) specifically so the test can inspect statusOf() DURING the window between
  // "needle fired" and "waitReady resolved", not just before-or-after it.
  it("statusOf reports 'starting' (not 'running') between the readiness needle and waitReady resolving", async () => {
    startMock.mockResolvedValueOnce(undefined);
    let resolveWaitReady!: () => void;
    const deferredWaitReady = vi.fn(
      () => new Promise<void>((resolve) => { resolveWaitReady = resolve; }),
    );
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), deferredWaitReady);
    const branch = fakeBranch();

    const startPromise = manager.start({ branch, pgVersion: 17 });

    // Wait for the mocked ManagedProcess.start() to resolve — the point at which the real
    // ManagedProcess would have already flipped proc.state to "running" (the needle fired).
    // The test double doesn't do that transition on its own, so drive it explicitly here to
    // model exactly that moment, then assert BEFORE waitReady has been given a chance to settle.
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    const constructedProc = ManagedProcessMock.mock.results[0]!.value as { state: string };
    constructedProc.state = "running";

    // deferredWaitReady is now pending (compute_ctl started, but apply_spec/SCRAM has not
    // committed) — statusOf must NOT say "running" here, and start() must not have resolved yet.
    expect(manager.statusOf(branch.id)).toBe("starting");
    let startSettled = false;
    void startPromise.then(() => { startSettled = true; });
    await Promise.resolve(); // flush one microtask turn — still must not have settled
    expect(startSettled).toBe(false);

    resolveWaitReady();
    await startPromise;

    expect(manager.statusOf(branch.id)).toBe("running");
  });

  // Fix 1 (review, regression guard): a crash DURING the readiness window (proc dies before
  // waitReady settles) must still read as "failed", not get stuck reporting "starting" forever.
  it("statusOf reports 'failed' if the proc dies while waitReady is still pending", async () => {
    startMock.mockResolvedValueOnce(undefined);
    const deferredWaitReady = vi.fn(() => new Promise<void>(() => {})); // never settles
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), deferredWaitReady);
    const branch = fakeBranch();

    void manager.start({ branch, pgVersion: 17 }).catch(() => {});

    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    const constructedProc = ManagedProcessMock.mock.results[0]!.value as { state: string };
    constructedProc.state = "running";
    expect(manager.statusOf(branch.id)).toBe("starting");

    constructedProc.state = "failed";
    expect(manager.statusOf(branch.id)).toBe("failed");
  });

  // Fix 3 (review, regression guard): the readiness-failure catch must never let a rejecting
  // proc.stop() mask the ORIGINAL readiness error or skip the cleanup lines after it. Before the
  // fix, `if (entry.proc) await entry.proc.stop();` with no try/catch meant a rejecting stop()
  // here would (a) surface the STOP error to the caller instead of the readiness timeout/failure,
  // and (b) never reach the map-delete/dir-remove/port-release lines below it — a stale map entry
  // (permanent "already ..." on every later start for this branch) plus leaked ports.
  it("start() failure cleanup surfaces the READINESS error (not a rejecting proc.stop()) and still releases ports/map entry", async () => {
    startMock.mockResolvedValueOnce(undefined);
    stopMock.mockRejectedValueOnce(new Error("stop() exploded during cleanup"));
    const readinessError = new Error("compute readiness timed out after 50000ms");
    // Fails the FIRST start's readiness gate only — the second start() at the end (proving the
    // branch stays restartable) must succeed, or this test couldn't tell "cleanup ran properly"
    // apart from "waitReady always rejects."
    const failingWaitReady = vi.fn()
      .mockRejectedValueOnce(readinessError)
      .mockResolvedValueOnce(undefined);
    const cfg = freshCfg({ DEVDB_PORT_RANGE: "54333-54333" });
    const manager = new ComputeManager(cfg, fakeLogger(), failingWaitReady);
    const branch = fakeBranch();

    await expect(manager.start({ branch, pgVersion: 17 })).rejects.toThrow("compute readiness timed out after 50000ms");

    expect(manager.statusOf(branch.id)).toBe("stopped");
    expect(manager.portOf(branch.id)).toBeNull();

    // Single-port range: this only resolves if the failed start released the reserved port
    // despite proc.stop() having rejected during its cleanup.
    startMock.mockResolvedValueOnce(undefined);
    await expect(manager.start({ branch, pgVersion: 17 })).resolves.toEqual({ port: 54333 });
  });
});
