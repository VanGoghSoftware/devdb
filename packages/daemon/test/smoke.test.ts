import { describe, expect, it } from "vitest";
import { DEVDB } from "@devdb/shared";

describe("workspace", () => {
  it("resolves shared package", () => {
    expect(DEVDB).toBe("devdb");
  });
});
