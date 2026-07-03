// Client preferences are deliberately localStorage, not daemon-persisted (spec Decision 3):
// per-browser is correct for a local tool, and the daemon stays free of a user-settings store.
export type TreeView = "rails" | "canvas";
export type ThemePref = "auto" | "light" | "dark";

const KEYS = { defaultTreeView: "devdb.defaultTreeView", theme: "devdb.theme" } as const;

export function getDefaultTreeView(): TreeView {
  return localStorage.getItem(KEYS.defaultTreeView) === "canvas" ? "canvas" : "rails";
}
export function setDefaultTreeView(v: TreeView): void {
  localStorage.setItem(KEYS.defaultTreeView, v);
}
export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEYS.theme);
  return v === "light" || v === "dark" ? v : "auto";
}
export function setThemePref(v: ThemePref): void {
  localStorage.setItem(KEYS.theme, v);
}
