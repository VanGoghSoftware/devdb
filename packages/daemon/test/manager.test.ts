import { existsSync, mkdtempSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
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

import { loadConfig } from "../src/config.js";
import { newHexId } from "../src/engine/ids.js";
import { ComputeManager } from "../src/compute/manager.js";
import { ManagedProcess } from "../src/engine/process.js";
import type { BranchRow } from "../src/state/repos.js";

const ManagedProcessMock = vi.mocked(ManagedProcess);

function freshCfg() {
  const dataDir = mkdtempSync(join(tmpdir(), "devdb-manager-test-"));
  return loadConfig({
    DEVDB_DATA_DIR: dataDir,
    NEON_BINARIES_DIR: "/usr/local/share/neon/bin",
    PG_INSTALL_DIR: "/usr/local/share/neon/pg_install",
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
    ]);

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
