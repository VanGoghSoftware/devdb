import { describe, expect, it, vi } from "vitest";
import { LogsService } from "../src/services/logs.js";
import { createLogger } from "../src/logging/logger.js";

describe("createLogger", () => {
  it("ingests a formatted line into the daemon:app channel and writes stderr", () => {
    const logs = new LogsService();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger(logs);
    logger.error("compensation failed — orphaned timeline t1", new Error("boom"));
    const recent = logs.recent("app");
    expect(recent).toHaveLength(1);
    expect(recent[0]).toContain("[error]");
    expect(recent[0]).toContain("orphaned timeline t1");
    expect(recent[0]).toContain("boom");
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
