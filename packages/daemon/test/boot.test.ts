import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startMock = vi.fn();
const stopMock = vi.fn(async () => {});
vi.mock("../src/engine/process.js", () => ({
  ManagedProcess: vi.fn(() => ({ start: startMock, stop: stopMock, state: "stopped", pid: null, recentLines: () => [] })),
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

describe("EngineRuntime partial-boot cleanup", () => {
  beforeEach(() => {
    startMock.mockReset();
    stopMock.mockClear();
    pgInit.mockClear();
    pgStart.mockClear();
    pgStop.mockClear();
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
  });
});
