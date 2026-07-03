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
import type { BranchRow } from "../src/state/repos.js";

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
    const manager = new ComputeManager(cfg);
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
    const manager = new ComputeManager(cfg);
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
    const manager = new ComputeManager(cfg);
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
    const manager = new ComputeManager(cfg);
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
    const manager = new ComputeManager(cfg);
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
    const manager = new ComputeManager(cfg);
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
    const manager = new ComputeManager(cfg);
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
    const manager = new ComputeManager(cfg);
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
    const manager = new ComputeManager(cfg);
    const branch = fakeBranch();
    await manager.start({ branch, pgVersion: 17 });

    const opts = ManagedProcessMock.mock.calls[0]![0] as { onLine: (line: string, stream: "stdout" | "stderr") => void };

    const secondReceived: string[] = [];
    manager.onLine(branch.id, () => { throw new Error("boom"); });
    manager.onLine(branch.id, (line) => secondReceived.push(line));

    expect(() => opts.onLine("hello world", "stdout")).not.toThrow();
    expect(secondReceived).toEqual(["hello world"]);
  });
});
