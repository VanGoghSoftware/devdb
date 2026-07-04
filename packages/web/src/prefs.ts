// Client preferences are deliberately localStorage, not daemon-persisted (spec Decision 3):
// per-browser is correct for a local tool, and the daemon stays free of a user-settings store.
export type TreeView = "rails" | "canvas";
export type ThemePref = "auto" | "light" | "dark";

// Single source of truth for the theme localStorage key literal — main.tsx's colorSchemeManager
// imports this constant instead of duplicating the string. Previously the same literal was
// hardcoded in both places (here and in main.tsx's colorSchemeManager({ key: "devdb.theme" })),
// which meant an edit to one without the other would silently split the "live scheme" key from the
// "persisted pref" key. Centralizing removes that drift risk entirely.
export const THEME_STORAGE_KEY = "devdb.theme";

const KEYS = { defaultTreeView: "devdb.defaultTreeView", theme: THEME_STORAGE_KEY } as const;

// localStorage can throw (SecurityError) when storage is disabled, e.g. private/incognito modes
// in some browsers. These getters run during render (e.g. Settings, and future startup reads),
// so an unguarded throw here would blank the whole SPA. Reads fall back to the documented
// default; writes are best-effort no-ops — losing a preference write is fine, crashing isn't.
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // best-effort; ignore
  }
}

export function getDefaultTreeView(): TreeView {
  return readStorage(KEYS.defaultTreeView) === "canvas" ? "canvas" : "rails";
}
export function setDefaultTreeView(v: TreeView): void {
  writeStorage(KEYS.defaultTreeView, v);
}
export function getThemePref(): ThemePref {
  const v = readStorage(KEYS.theme);
  return v === "light" || v === "dark" ? v : "auto";
}
export function setThemePref(v: ThemePref): void {
  writeStorage(KEYS.theme, v);
}
