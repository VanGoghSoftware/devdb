import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startMock = vi.fn();
const stopMock = vi.fn(async () => {});
vi.mock("../src/engine/process.js", () => ({
  // opts is captured (not discarded) so Fix 3 (Task 6 fix wave) can assert the engine-binary
  // construction path never passes detached: true — mirrors manager.test.ts's ManagedProcessMock
  // capture, reusing the same construction-capture rather than adding new test machinery.
  ManagedProcess: vi.fn((opts: unknown) => ({ start: startMock, stop: stopMock, state: "stopped", pid: null, recentLines: () => [], __opts: opts })),
}));
const pgInit = vi.fn(async () => {});
const pgStart = vi.fn(async () => {});
const pgStop = vi.fn(async () => {});
vi.mock("../src/engine/embedded-postgres.js", () => ({
  EmbeddedPostgres: vi.fn(() => ({ init: pgInit, start: pgStart, stop: pgStop, connectionUri: () => "postgresql://devdb:x@127.0.0.1:5431/postgres" })),
}));

import { EngineRuntime } from "../src/engine/boot.js";
import { loadConfig } from "../src/config.js";
import { openState } from "../src/state/db.js";
import { LogsService } from "../src/services/logs.js";
import { ManagedProcess } from "../src/engine/process.js";

const ManagedProcessMock = vi.mocked(ManagedProcess);

describe("EngineRuntime partial-boot cleanup", () => {
  beforeEach(() => {
    startMock.mockReset();
    stopMock.mockClear();
    pgInit.mockClear();
    pgStart.mockClear();
    pgStop.mockClear();
    ManagedProcessMock.mockClear();
  });

  it("reverse-stops started components when a later phase fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "devdb-boot-test-"));
    const cfg = loadConfig({
      DEVDB_DATA_DIR: dataDir,
      NEON_BINARIES_DIR: "/usr/local/share/neon/bin",
      PG_INSTALL_DIR: "/usr/local/share/neon/pg_install",
    });

    // broker (1st ManagedProcess) starts fine; storage_controller (2nd) fails.
    // Failing here guarantees safekeeper registration's fetch() never fires — stays offline.
    startMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("storcon exploded"));

    const engine = new EngineRuntime(cfg, openState(":memory:"), new LogsService());
    await expect(engine.start()).rejects.toThrow("storcon exploded");
    expect(stopMock).toHaveBeenCalled(); // started ManagedProcess(es) stopped
    expect(pgStop).toHaveBeenCalled(); // storcon DB stopped too

    // Fix 3 (review, Task 6 fix wave): pin the detached-scope contract from the other side — the
    // engine binaries (broker/storage_controller here; safekeeper/pageserver never reach
    // construction in this failing-boot scenario, but the same launch() call site constructs all
    // four identically, so asserting on whichever calls DID happen still pins the contract) must
    // NOT be detached. They don't fork surviving children (unlike compute_ctl), so plain child-pid
    // signaling is correct for them; detached: true here would be scope creep with no matching
    // need, silently changing their process-group semantics. Reuses this test's existing
    // (already-passing, no new fetch/network mocking needed) scenario rather than adding a new one.
    expect(ManagedProcessMock).toHaveBeenCalledTimes(2); // broker, storage_controller
    for (const call of ManagedProcessMock.mock.calls) {
      const opts = call[0] as { name: string; detached?: boolean };
      expect(opts.detached).not.toBe(true);
    }
  });
});
