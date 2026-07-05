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

// Task 8: allocatePort is spied (not fully replaced) so every EXISTING test in this file keeps
// its real bind-and-probe behavior (including the exhaustion tests, which depend on genuinely
// running out of real ports) — the default implementation below just calls straight through to
// the real function. Only the new --pgbin/runningPgbin test overrides this per-call via
// mockResolvedValueOnce, so it never touches a real socket regardless of what else is bound on
// the host (this environment currently has a container holding the entire default port range —
// see docs/superpowers/sdd/progress.md's ENV NOTE — so real-bind tests in THIS file already fail
// here; the new test must not add to that list by depending on a real bind of its own).
const allocatePortMock = vi.hoisted(() => vi.fn());
vi.mock("../src/compute/ports.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/compute/ports.js")>();
  allocatePortMock.mockImplementation(actual.allocatePort);
  return { ...actual, allocatePort: allocatePortMock };
});
const realAllocatePort = (await vi.importActual<typeof import("../src/compute/ports.js")>("../src/compute/ports.js")).allocatePort;

import { loadConfig } from "../src/config.js";
import { newHexId } from "../src/engine/ids.js";
import { ComputeManager } from "../src/compute/manager.js";
import { ManagedProcess } from "../src/engine/process.js";
import type { waitComputeReady } from "../src/compute/readiness.js";
import type { PortProbe } from "../src/compute/ports.js";
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

// ComputeManager's 5th (optional) constructor arg injects the bind probe allocatePort uses. The
// real tryBind binds 127.0.0.1:<candidate>, which docker-proxy holds across the entire published
// DEVDB_PORT_RANGE (54300-54339 — this file's freshCfg default, and the 5433x single-port ranges a
// few tests set explicitly) whenever the compose container is up, so every real-probe start() here
// exhausts the range and throws PortExhaustedError with the product running. This fake grants every
// candidate without ever touching the OS, making the suite hermetic whether or not devdb is up.
// allocatePort's own reserved-set dedup still hands back three DISTINCT ports per start() (endpoint
// + metrics + internal-http), so the always-grant probe is safe. Real tryBind behaviour is covered
// against a genuinely-free ephemeral port in ports.test.ts.
function fakeProbe(): PortProbe {
  return vi.fn(async () => true);
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
    allocatePortMock.mockReset();
    allocatePortMock.mockImplementation(realAllocatePort);
    ManagedProcessMock.mockClear();
  });

  it("start() constructs ManagedProcess with the oracle launch contract and writes config files", async () => {
    startMock.mockResolvedValueOnce(undefined);
    const cfg = freshCfg();
    const probe = fakeProbe();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, probe);
    const branch = fakeBranch();

    // Task 8: pgbinPath is deliberately NOT under cfg.pgInstallDir/v{pgVersion} — this test's own
    // --pgbin assertion below must prove byte-exact PASS-THROUGH of the caller-resolved path, not
    // coincidentally match a value that could ALSO have come from the old
    // join(pgInstallDir, `v${pgVersion}`, "bin", "postgres") derivation this task removed.
    const pgbinPath = "/data/pg_builds/v17/deadbeef/bin/postgres";
    const { port } = await manager.start({ branch, pgVersion: 17, pgbinPath });

    expect(ManagedProcessMock).toHaveBeenCalledTimes(1);
    const opts = ManagedProcessMock.mock.calls[0]![0] as {
      bin: string; args: string[]; env: Record<string, string>;
      readyNeedle: string; readyTimeoutMs: number; detached?: boolean;
      onLine: (line: string, stream: "stdout" | "stderr") => void;
    };
    expect(opts.bin).toBe(join(cfg.neonBinDir, "compute_ctl"));
    expect(opts.env).toEqual({});
    expect(opts.readyNeedle).toBe("listening on IPv4 address");
    expect(opts.readyTimeoutMs).toBe(50_000);
    // Fix 3 (review, Task 6 fix wave): pin the detached-scope contract so it can't silently
    // regress — compute_ctl's ManagedProcess MUST be detached (own process group), since that's
    // the whole mechanism stop() relies on to group-kill its orphaned postgres child (see
    // process.ts's detached-path SIGKILL escalation and manager.ts's oracle-launch comment above).
    expect(opts.detached).toBe(true);

    // Recover the temp dir compute_ctl was launched with, to assert byte-exact arg order.
    const computesDir = join(cfg.dataDir, "computes");
    const children = await readdir(computesDir);
    expect(children).toHaveLength(1);
    const dir = join(computesDir, children[0]!);

    expect(opts.args).toEqual([
      "--pgdata", join(dir, "pg_data"),
      "--pgbin", pgbinPath,
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

    // P5 (review-broker): pin that ALL THREE allocations (endpoint + metrics + internal-http) went
    // through the INJECTED probe, not the real OS bind. The endpoint port lives in the published
    // DEVDB_PORT_RANGE, so a dropped `this.probe` there fails loudly under docker-proxy — but the two
    // HTTP-port allocations draw from the usually-free 40000-40999 range, so a future edit that stops
    // threading the probe into them would silently fall back to real tryBind and still pass. Assert
    // the fake was consulted once per allocation, on each handed-out port, so that regression is
    // deterministic. (fakeProbe grants immediately, so reserved-skips never probe → exactly 3.)
    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe).toHaveBeenCalledWith(port);
    expect(probe).toHaveBeenCalledWith(externalHttpPort);
    expect(probe).toHaveBeenCalledWith(internalHttpPort);

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
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, fakeProbe());
    const branch = fakeBranch();

    const firstStart = manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" });

    // The map slot is reserved synchronously before the first await inside start(), but the
    // first call still needs to run its own setup (port alloc, dir/file writes) before it
    // reaches ManagedProcess.start(). Wait for that so this assertion exercises the real
    // concurrent-in-flight case, not a race against the first call's own microtasks.
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));

    await expect(manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" })).rejects.toThrow(/already/);

    releaseFirstStart();
    await firstStart;
  });

  it("cleans up the map entry, temp dir, and reserved ports when the launch fails", async () => {
    startMock.mockRejectedValueOnce(new Error("compute_ctl exploded"));
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, fakeProbe());
    const branch = fakeBranch();

    await expect(manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" })).rejects.toThrow("compute_ctl exploded");

    expect(manager.statusOf(branch.id)).toBe("stopped");
    expect(manager.portOf(branch.id)).toBeNull();

    const computesDir = join(cfg.dataDir, "computes");
    const children = await readdir(computesDir).catch(() => []);
    expect(children).toHaveLength(0);

    // Ports must have been released, or a fresh start (also on this same branch) would throw
    // PortExhaustedError/hang re-binding a still-reserved port instead of proceeding normally.
    startMock.mockResolvedValueOnce(undefined);
    await expect(manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" })).resolves.toEqual({ port: expect.any(Number) });
  });

  // start()'s failure cleanup shares stop()'s reap+rm discipline (removeComputeDir): a launch
  // that dies mid-start (e.g. the readiness timeout SIGKILLing compute_ctl) orphans a live
  // postgres exactly like stop() does, so the failure-path rm races the same still-live writer.
  // The first rm fails ENOTEMPTY with a straggler written behind the walk; the retry (real rm)
  // must clear it, and the caller must see the ORIGINAL launch error, not the rm error.
  it("start() failure cleanup retries reap+rm on ENOTEMPTY and still throws the launch error", async () => {
    startMock.mockRejectedValueOnce(new Error("compute_ctl not ready within 50000ms"));
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, fakeProbe());
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

    await expect(manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" })).rejects.toThrow("compute_ctl not ready within 50000ms");

    expect(rmMock).toHaveBeenCalledTimes(2);
    expect(dirSeen).not.toBe("");
    expect(existsSync(dirSeen)).toBe(false);
    expect(manager.statusOf(branch.id)).toBe("stopped");

    startMock.mockResolvedValueOnce(undefined);
    await expect(manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" })).resolves.toEqual({ port: expect.any(Number) });
  });

  // The two hazards the old inline failure-path rm (no try/catch) had beyond the ENOTEMPTY race
  // itself: an rm throw REPLACED the original launch error, and skipped the map delete after it —
  // a stale entry that made every later start() for the branch throw "already ..." until the
  // daemon restarted. Persistent rm failure is the sharpest probe for both: the caller must
  // still see the launch error, and the branch must restart cleanly on the SAME single port.
  it("start() failure cleanup never masks the launch error when rm fails persistently, and the branch stays restartable", async () => {
    startMock.mockRejectedValueOnce(new Error("compute_ctl exploded"));
    const cfg = freshCfg({ DEVDB_PORT_RANGE: "54332-54332" });
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, fakeProbe());
    const branch = fakeBranch();

    rmMock.mockImplementation(async () => {
      throw Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" });
    });

    await expect(manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" })).rejects.toThrow("compute_ctl exploded");
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
    await expect(manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" })).resolves.toEqual({ port: 54332 });
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
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, fakeProbe());
    const branch = fakeBranch();
    const received: string[] = [];

    const startPromise = manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres", onLine: (line) => received.push(line) });

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
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, fakeProbe());
    const branch = fakeBranch();
    const received: string[] = [];

    const startPromise = manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres", onLine: (line) => received.push(line) });

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
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, fakeProbe());
    const branch = fakeBranch();
    await manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" });

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
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, fakeProbe());
    const branch = fakeBranch();
    await manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" });

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
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, fakeProbe());
    const branch = fakeBranch();
    await expect(manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" })).resolves.toEqual({ port: 54331 });
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
    await expect(manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" })).resolves.toEqual({ port: 54331 });
  });

  it("isolates onLine listeners: a throwing listener does not prevent later listeners from receiving the line", async () => {
    startMock.mockResolvedValueOnce(undefined);
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, fakeProbe());
    const branch = fakeBranch();
    await manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" });

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
    const manager = new ComputeManager(cfg, fakeLogger(), deferredWaitReady, undefined, fakeProbe());
    const branch = fakeBranch();

    const startPromise = manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" });

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
    const manager = new ComputeManager(cfg, fakeLogger(), deferredWaitReady, undefined, fakeProbe());
    const branch = fakeBranch();

    void manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" }).catch(() => {});

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
    const manager = new ComputeManager(cfg, fakeLogger(), failingWaitReady, undefined, fakeProbe());
    const branch = fakeBranch();

    await expect(manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" })).rejects.toThrow("compute readiness timed out after 50000ms");

    expect(manager.statusOf(branch.id)).toBe("stopped");
    expect(manager.portOf(branch.id)).toBeNull();

    // Single-port range: this only resolves if the failed start released the reserved port
    // despite proc.stop() having rejected during its cleanup.
    startMock.mockResolvedValueOnce(undefined);
    await expect(manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" })).resolves.toEqual({ port: 54333 });
  });

  // Task 3 (phase 3): onStatusChange is the async-observer seam index.ts wires to /api/events —
  // it must fire at every point statusOf(branchId) may have changed with no caller-visible write:
  // map-slot reservation (statusOf flips from "stopped" to "starting" the instant start() is
  // called, before any await), the phase flip to "running" after waitReady settles, the phase
  // flip to "stopping" at the top of stop(), and the terminal "stopped" once the entry is removed.
  // Drives waitReady manually (like the "statusOf reports 'starting'..." test above) to get a hook
  // point BEFORE it resolves — the mocked ManagedProcess's `state` never advances on its own
  // (unlike the real class), so it has to be driven to "running" by hand for statusOf() to agree.
  it("onStatusChange fires across the compute lifecycle: reserve, running, stopping, gone", async () => {
    startMock.mockResolvedValueOnce(undefined);
    let resolveWaitReady!: () => void;
    const deferredWaitReady = vi.fn(
      () => new Promise<void>((resolve) => { resolveWaitReady = resolve; }),
    );
    const cfg = freshCfg();
    const ticks: string[] = [];
    const branch = fakeBranch();
    const manager = new ComputeManager(
      cfg, fakeLogger(), deferredWaitReady,
      (branchId) => ticks.push(`${branchId}:${manager.statusOf(branchId)}`),
      fakeProbe(),
    );

    const startPromise = manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" });
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    const constructedProc = ManagedProcessMock.mock.results[0]!.value as { state: string };
    constructedProc.state = "running"; // needle fired — models the real class's own transition
    resolveWaitReady();
    await startPromise;

    await manager.stop(branch.id);

    expect(ticks[0]).toBe(`${branch.id}:starting`); // map-slot reservation, before any await
    expect(ticks).toContain(`${branch.id}:running`); // phase flip after waitReady resolves
    expect(ticks).toContain(`${branch.id}:stopping`); // stop()'s phase flip
    expect(ticks[ticks.length - 1]).toBe(`${branch.id}:stopped`); // entry removed — statusOf falls back to "stopped"
  });

  // A launch that fails readiness must still announce its terminal state: without this, a
  // failed start's map entry cleanup (this file's other failure-cleanup tests) would be
  // invisible to any /api/events subscriber that only ever heard "starting".
  it("a failed start announces the terminal state after cleanup", async () => {
    startMock.mockResolvedValueOnce(undefined);
    const readinessError = new Error("compute readiness timed out after 50000ms");
    const failingWaitReady = vi.fn().mockRejectedValueOnce(readinessError);
    const cfg = freshCfg();
    const ticks: string[] = [];
    const branch = fakeBranch();
    const manager = new ComputeManager(
      cfg, fakeLogger(), failingWaitReady,
      (branchId) => ticks.push(manager.statusOf(branchId)),
      fakeProbe(),
    );

    await expect(manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" })).rejects.toThrow("compute readiness timed out after 50000ms");

    expect(ticks[ticks.length - 1]).toBe("stopped"); // entry deleted by the catch's cleanup
  });

  // The per-compute ManagedProcess is also wired with its own onStateChange (not just the three
  // ComputeManager-driven notifyStatus call sites above) — a crash AFTER running (no ComputeManager
  // method call at all; the mocked ManagedProcess instance settles its own state independently)
  // must still reach onStatusChange, or a compute dying mid-flight would go unreported forever.
  it("a crash-after-running on the underlying ManagedProcess reaches onStatusChange via its own onStateChange wiring", async () => {
    startMock.mockResolvedValueOnce(undefined);
    const cfg = freshCfg();
    const ticks: string[] = [];
    const branch = fakeBranch();
    const manager = new ComputeManager(
      cfg, fakeLogger(), fakeWaitReady(),
      (branchId) => ticks.push(`${branchId}:${manager.statusOf(branchId)}`),
      fakeProbe(),
    );

    await manager.start({ branch, pgVersion: 17, pgbinPath: "/usr/local/share/neon/pg_install/v17/bin/postgres" });
    ticks.length = 0; // only care about what happens after start() has already settled

    const opts = ManagedProcessMock.mock.calls[0]![0] as { onStateChange?: (s: string) => void };
    expect(opts.onStateChange).toBeTypeOf("function");
    opts.onStateChange!("failed"); // simulate the crash the mock itself doesn't model

    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatch(new RegExp(`^${branch.id}:`));
  });

  // Task 8: start() now takes a caller-RESOLVED pgbinPath (the BuildRegistry's active build for
  // this project's major, resolved by EndpointsService — see endpoints.ts) instead of joining
  // `pgInstallDir/v{pgVersion}/bin/postgres` itself. This is what makes "adopt on restart"
  // structural: ComputeManager has no opinion on WHICH build backs a version, it just launches
  // whatever path it's handed. allocatePortMock is overridden here (not the real bind) so this
  // test never depends on a real free port existing in cfg.portRange — this environment currently
  // has that whole range externally held (see the allocatePortMock doc comment above), and this
  // test's whole point is the --pgbin arg / runningPgbin(), not port allocation.
  it("start passes the caller-resolved pgbinPath to compute_ctl --pgbin and exposes it via runningPgbin", async () => {
    startMock.mockResolvedValueOnce(undefined);
    allocatePortMock
      .mockResolvedValueOnce(54300) // main compute port
      .mockResolvedValueOnce(40100) // metrics (external-http) port
      .mockResolvedValueOnce(40101); // internal-http port
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();
    const pgbinPath = "/data/pg_builds/v16/9124/bin/postgres";

    await manager.start({ branch, pgVersion: 16, pgbinPath });

    const opts = ManagedProcessMock.mock.calls[0]![0] as { args: string[] };
    // Byte-exact: the caller-resolved path is passed through verbatim, NOT a
    // pgInstallDir-joined path built from pgVersion.
    const pgbinIdx = opts.args.indexOf("--pgbin");
    expect(pgbinIdx).toBeGreaterThanOrEqual(0);
    expect(opts.args[pgbinIdx + 1]).toBe(pgbinPath);
    expect(opts.args).not.toContain(join(cfg.pgInstallDir, "v16", "bin", "postgres"));

    expect(manager.runningPgbin(branch.id)).toBe(pgbinPath);
    expect(manager.runningPgbins()).toEqual([pgbinPath]);

    await manager.stop(branch.id);

    expect(manager.runningPgbin(branch.id)).toBeNull();
    expect(manager.runningPgbins()).toEqual([]);
  });

  it("start() publishes pgbinPath into runningPgbins() SYNCHRONOUSLY, before its first await — load-bearing for the endpoint↔build-lane rm guard", async () => {
    // Override allocatePort per-call + the mocked proc start (docker-devdb-1 holds the default port
    // range — see the allocatePort mock note atop this file), so this test never binds a real
    // socket; it exercises only the synchronous map reservation.
    startMock.mockResolvedValueOnce(undefined);
    allocatePortMock
      .mockResolvedValueOnce(54300)  // main compute port
      .mockResolvedValueOnce(40100)  // metrics port
      .mockResolvedValueOnce(40101); // internal-http port
    const cfg = freshCfg();
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady());
    const branch = fakeBranch();
    const pgbinPath = "/data/pg_builds/v16/9124/bin/postgres";

    // Invoke start() but do NOT await it: the reservation must be visible in the SAME synchronous
    // tick. This pins the invariant that keeps the endpoint-vs-build-lane rm race closed (verified
    // not-reachable 2026-07-05, controller analysis + review broker): endpoints.startLocked()
    // resolves builds.pgbinFor() and calls computes.start() with NO await in between, and start()
    // does `computes.set(entry{pgbinPath})` synchronously before its first await — so a build a
    // compute is starting on is already "in use" (runningPgbins → assertRemovable's in-use check)
    // before any yield point lets a concurrent provisioner.remove() rm its --pgbin dir. If a
    // future refactor moves the reservation after start()'s first await, THIS test fails loudly.
    // (The other half — startLocked calling computes.start with NO await after pgbinFor — is pinned
    // separately by endpoints-service.test.ts "startLocked calls computes.start() synchronously".)
    const starting = manager.start({ branch, pgVersion: 16, pgbinPath });
    expect(manager.runningPgbins()).toContain(pgbinPath);
    expect(manager.runningPgbin(branch.id)).toBe(pgbinPath);

    await starting;
    await manager.stop(branch.id);
  });

  // ── stop()-during-start() race at the ComputeManager level (sibling to a74b8b1's
  // ManagedProcess-level guard) ───────────────────────────────────────────────────────────────
  // start() reserves its map slot synchronously (computes.set, proc still null) and then crosses
  // several awaits — allocatePort ×3, mkdir/mkdtemp, writeFile ×2 — BEFORE it constructs entry.proc.
  // A concurrent stopAll() (daemon shutdown, index.ts — it iterates computes directly, BYPASSING the
  // per-branch queue lane that otherwise serializes a branch's start/stop) landing in that pre-proc
  // window sees proc===null, so it sets phase="stopping", SKIPS proc.stop() (no proc to stop),
  // deletes the map slot, and releases the ports. Pre-fix, the suspended start() re-checked nothing
  // on resume: it sailed on to spawn compute_ctl, waitReady, flip "running", and RETURN SUCCESS for
  // an entry no longer in the map — a live compute invisible to statusOf()/runningPorts(), leaked
  // until the container is torn down, on a port stop() may already have re-handed. RED evidence
  // (pre-fix): startPromise RESOLVES {port} and ManagedProcess WAS constructed (a spawned, unstopped,
  // orphaned compute).
  it("start() aborts (rejects, launches nothing) when stopAll() claims the entry during a pre-proc await", async () => {
    // Single endpoint-port range so the restart at the end proves the aborted start RELEASED its
    // port (a leak would make the reclaim throw PortExhaustedError). The deferred probe parks the
    // FIRST allocatePort at `await probe(candidate)` — candidate already claimed into reservedPorts
    // (reserve-then-probe, see ports.ts) but not yet recorded on entry, proc still null — modeling
    // start() caught mid-setup. Later probes grant immediately so stopAll and the restart never
    // touch a real socket.
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((r) => { releaseProbe = r; });
    let probeCalls = 0;
    const probe: PortProbe = vi.fn(async () => {
      probeCalls += 1;
      if (probeCalls === 1) await probeGate;
      return true;
    });
    const cfg = freshCfg({ DEVDB_PORT_RANGE: "54321-54321" });
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, probe);
    const branch = fakeBranch();

    const startPromise = manager.start({ branch, pgVersion: 17, pgbinPath: "/data/pg_builds/v17/x/bin/postgres" });
    // Park at the first probe: setup is in flight, entry.proc not yet constructed.
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    expect(ManagedProcessMock).not.toHaveBeenCalled();
    expect(manager.statusOf(branch.id)).toBe("starting");

    // Shutdown: stopAll() claims the proc-less entry (phase→stopping, no proc.stop(), slot deleted).
    await manager.stopAll();
    expect(manager.statusOf(branch.id)).toBe("stopped");

    // Resume the parked allocation. The fixed start() must ABORT into its catch, not sail on.
    releaseProbe();
    await expect(startPromise).rejects.toThrow(/stop\(\) intervened during startup/);

    // Nothing was launched (no orphaned compute_ctl), and the port was released.
    expect(ManagedProcessMock).not.toHaveBeenCalled();
    expect(manager.statusOf(branch.id)).toBe("stopped");
    startMock.mockResolvedValueOnce(undefined);
    await expect(
      manager.start({ branch, pgVersion: 17, pgbinPath: "/data/pg_builds/v17/x/bin/postgres" }),
    ).resolves.toEqual({ port: 54321 });
  });

  // The other half of the same race: stopAll() arrives AFTER entry.proc is constructed and
  // proc.start() has resolved, while start() is parked at the structural readiness gate
  // (await this.waitReady). Here stop() DOES see a proc and stops it — but if waitReady then
  // resolves "running" (its last poll caught the compute up microseconds before SIGTERM landed),
  // pre-fix start() flips entry.phase="running" and RETURNS SUCCESS for the torn-down entry. The
  // pre-"running" fence must reject instead. (a74b8b1 guards ManagedProcess.start()'s OWN readiness
  // needle; this is the SEPARATE ComputeManager-level waitReady gate one layer up.) RED evidence
  // (pre-fix): startPromise RESOLVES {port}.
  it("start() aborts if stopAll() claims the entry after proc.start() while waitReady is still pending", async () => {
    startMock.mockResolvedValueOnce(undefined); // needle fired: proc.start() resolves
    let releaseReady!: () => void;
    const readyGate = new Promise<void>((r) => { releaseReady = r; });
    const deferredWaitReady = vi.fn(() => readyGate);
    const cfg = freshCfg({ DEVDB_PORT_RANGE: "54322-54322" });
    const manager = new ComputeManager(cfg, fakeLogger(), deferredWaitReady, undefined, fakeProbe());
    const branch = fakeBranch();

    const startPromise = manager.start({ branch, pgVersion: 17, pgbinPath: "/data/pg_builds/v17/x/bin/postgres" });
    // Park at waitReady: proc constructed, proc.start() resolved, readiness not yet committed.
    await vi.waitFor(() => expect(deferredWaitReady).toHaveBeenCalledTimes(1));
    expect(ManagedProcessMock).toHaveBeenCalledTimes(1);

    // Shutdown mid-readiness: stopAll() stops the proc (proc !== null now), deletes the slot,
    // releases the ports.
    await manager.stopAll();
    expect(stopMock).toHaveBeenCalled();          // the constructed proc WAS ordered to stop
    expect(manager.statusOf(branch.id)).toBe("stopped");

    // waitReady resolves "running" after the teardown. start() must NOT resurrect the entry to
    // "running" nor report success.
    releaseReady();
    await expect(startPromise).rejects.toThrow(/stop\(\) intervened during startup/);
    expect(manager.statusOf(branch.id)).toBe("stopped");

    // Port released → branch restartable on the same single port.
    startMock.mockResolvedValueOnce(undefined);
    await expect(
      manager.start({ branch, pgVersion: 17, pgbinPath: "/data/pg_builds/v17/x/bin/postgres" }),
    ).resolves.toEqual({ port: 54322 });
  });

  // Regression for the review-broker P3: the aborted start's compensation must be OWNER-SAFE for a
  // port stopAll() already released and ANOTHER branch has since reclaimed. Interleaving: branch A's
  // start() records entry.port=P and parks at its metrics allocation; stopAll() frees P and deletes
  // A's slot; branch B (admitted after stopAll's key snapshot) reclaims the freed P and fully starts
  // on it; A then resumes, trips a later fence, and enters its catch. Pre-hardening that catch did a
  // blind `reservedPorts.delete(P)` — evicting B's LIVE reservation, so a THIRD start is wrongly
  // handed the same P (a duplicate allocation: two computes on one port). The releasePort fix nulls
  // each port on the entry as it's freed (in BOTH stop() and the catch), so the second releaser sees
  // null and skips. RED evidence (pre-fix): branch C's start RESOLVES { port: 54321 } (== B's port).
  it("an aborted start does not evict a port that stopAll() freed and another branch already reclaimed", async () => {
    let releaseMetricsProbe!: () => void;
    const metricsGate = new Promise<void>((r) => { releaseMetricsProbe = r; });
    let probeCalls = 0;
    // Park ONLY A's metrics allocation (probe call #2): by then A's endpoint port (call #1) is
    // granted and recorded on entry, so stopAll() below frees a port A is holding, not one still
    // mid-claim. Every other probe (B's three, plus A's eventual metrics on resume) grants at once.
    const probe: PortProbe = vi.fn(async () => {
      probeCalls += 1;
      if (probeCalls === 2) await metricsGate;
      return true;
    });
    const cfg = freshCfg({ DEVDB_PORT_RANGE: "54321-54321" }); // single endpoint port — the contested P
    const manager = new ComputeManager(cfg, fakeLogger(), fakeWaitReady(), undefined, probe);
    const branchA = fakeBranch();
    const branchB = fakeBranch();
    const branchC = fakeBranch();

    // A parks at its metrics allocation with entry.port=54321 already recorded.
    const startA = manager.start({ branch: branchA, pgVersion: 17, pgbinPath: "/data/pg_builds/v17/x/bin/postgres" });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

    // Shutdown teardown of A frees 54321 and deletes A's slot (A's proc was never constructed).
    await manager.stopAll();
    expect(manager.statusOf(branchA.id)).toBe("stopped");

    // B is admitted after the snapshot, reclaims the freed 54321, and fully starts on it.
    startMock.mockResolvedValueOnce(undefined);
    await expect(
      manager.start({ branch: branchB, pgVersion: 17, pgbinPath: "/data/pg_builds/v17/x/bin/postgres" }),
    ).resolves.toEqual({ port: 54321 });
    expect(manager.portOf(branchB.id)).toBe(54321);

    // A resumes and aborts. Its catch must NOT touch 54321 (now B's).
    releaseMetricsProbe();
    await expect(startA).rejects.toThrow(/stop\(\) intervened during startup/);

    // Proof B's reservation survived: a third start on the same single-port range is REFUSED (54321
    // still reserved by B), not handed the same port a second time.
    await expect(
      manager.start({ branch: branchC, pgVersion: 17, pgbinPath: "/data/pg_builds/v17/x/bin/postgres" }),
    ).rejects.toThrow(/no free port/i);
    expect(manager.portOf(branchB.id)).toBe(54321); // B still holds it, undisturbed
  });

  // Regression for the rescan P3: on the post-waitReady abort path, start()'s catch must NOT release
  // the port / remove the dir while a concurrent stopAll() is STILL killing compute_ctl. The real
  // ManagedProcess.stop() nulls this.child synchronously (process.ts:220), so the catch's SECOND
  // stop() returns at once even though stopAll()'s FIRST stop() is still awaiting the process to
  // actually exit — so a blind catch cleanup would free a port / rm a pgdata dir the dying process
  // still holds. The fix defers teardown to the owning stop() when proc was constructed and stop()
  // took the entry. RED evidence (pre-fix): a fresh start on the single-port range SUCCEEDS while
  // stopAll() is still in flight (premature release), and statusOf() is "stopped" (the catch wrongly
  // deleted the entry the in-flight stop still owns).
  it("post-waitReady abort defers port/dir teardown to a stopAll() still killing the process", async () => {
    startMock.mockResolvedValueOnce(undefined); // A's proc.start() resolves (needle fired)
    // stopAll()'s stop() awaits the FIRST proc.stop() (models compute_ctl taking seconds to die);
    // the catch's SECOND proc.stop() resolves at once, as the real class does once child is nulled.
    let releaseFirstStop!: () => void;
    const firstStopGate = new Promise<void>((r) => { releaseFirstStop = r; });
    stopMock.mockImplementationOnce(() => firstStopGate).mockImplementation(async () => {});
    let releaseReady!: () => void;
    const readyGate = new Promise<void>((r) => { releaseReady = r; });
    const deferredWaitReady = vi.fn(() => readyGate);
    const cfg = freshCfg({ DEVDB_PORT_RANGE: "54323-54323" });
    const manager = new ComputeManager(cfg, fakeLogger(), deferredWaitReady, undefined, fakeProbe());
    const branchA = fakeBranch();
    const branchB = fakeBranch();

    const startA = manager.start({ branch: branchA, pgVersion: 17, pgbinPath: "/data/pg_builds/v17/x/bin/postgres" });
    await vi.waitFor(() => expect(deferredWaitReady).toHaveBeenCalledTimes(1)); // A parked at waitReady, proc built

    // stopAll() begins tearing A down but SUSPENDS awaiting the first proc.stop() (compute_ctl dying).
    const stopAllPromise = manager.stopAll();
    await vi.waitFor(() => expect(stopMock).toHaveBeenCalledTimes(1));

    // waitReady wins the race against SIGTERM and resolves — A resumes, trips the fence, aborts.
    releaseReady();
    await expect(startA).rejects.toThrow(/stop\(\) intervened during startup/);

    // stopAll() is STILL in flight (compute_ctl not yet dead), and it — not the aborted start — owns
    // A's teardown: the entry is still present as "stopping", and 54323 must NOT have been freed. A
    // fresh start on the single-port range is refused until stopAll() settles.
    expect(manager.statusOf(branchA.id)).toBe("stopping");
    await expect(
      manager.start({ branch: branchB, pgVersion: 17, pgbinPath: "/data/pg_builds/v17/x/bin/postgres" }),
    ).rejects.toThrow(/no free port/i);

    // compute_ctl finally dies → stopAll()'s stop() runs its finally, releasing the port AFTER death.
    releaseFirstStop();
    await stopAllPromise;
    expect(manager.statusOf(branchA.id)).toBe("stopped");

    // Now the port is free and a fresh start binds it.
    startMock.mockResolvedValueOnce(undefined);
    await expect(
      manager.start({ branch: branchB, pgVersion: 17, pgbinPath: "/data/pg_builds/v17/x/bin/postgres" }),
    ).resolves.toEqual({ port: 54323 });
  });
});
