import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultTreeView,
  setDefaultTreeView,
  getThemePref,
  setThemePref,
} from "../src/prefs.js";

beforeEach(() => {
  localStorage.clear();
});

describe("getDefaultTreeView / setDefaultTreeView", () => {
  it("defaults to rails when nothing is stored", () => {
    expect(getDefaultTreeView()).toBe("rails");
  });

  it("round-trips canvas", () => {
    setDefaultTreeView("canvas");
    expect(getDefaultTreeView()).toBe("canvas");
  });

  it("falls back to rails for an invalid stored value", () => {
    localStorage.setItem("devdb.defaultTreeView", "bogus");
    expect(getDefaultTreeView()).toBe("rails");
  });

  it("writes to the devdb.defaultTreeView key", () => {
    setDefaultTreeView("canvas");
    expect(localStorage.getItem("devdb.defaultTreeView")).toBe("canvas");
  });
});

describe("getThemePref / setThemePref", () => {
  it("defaults to auto when nothing is stored", () => {
    expect(getThemePref()).toBe("auto");
  });

  it("round-trips light", () => {
    setThemePref("light");
    expect(getThemePref()).toBe("light");
  });

  it("round-trips dark", () => {
    setThemePref("dark");
    expect(getThemePref()).toBe("dark");
  });

  it("falls back to auto for an invalid stored value", () => {
    localStorage.setItem("devdb.theme", "bogus");
    expect(getThemePref()).toBe("auto");
  });

  it("writes to the devdb.theme key", () => {
    setThemePref("dark");
    expect(localStorage.getItem("devdb.theme")).toBe("dark");
  });
});

describe("getThemePref storage guard", () => {
  it("returns auto instead of throwing when localStorage.getItem throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage disabled");
    });
    expect(() => getThemePref()).not.toThrow();
    expect(getThemePref()).toBe("auto");
    spy.mockRestore();
  });
});
