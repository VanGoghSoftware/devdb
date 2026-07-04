// Runtime matcher registration. We do NOT use jest-dom's `import "@testing-library/jest-dom/vitest"`
// side-effect entry: from its spot in the pnpm store, jest-dom's own `require('vitest')` resolves to
// a stray vitest@3 copy hoisted by another workspace member, so it would call expect.extend on the
// WRONG expect and toBeInTheDocument would be undefined at our call sites. Instead register the raw
// matchers against THIS package's vitest-4 `expect` explicitly. (Types come from ./vitest.d.ts.)
import { afterEach, expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
expect.extend(matchers);

// vite.config.ts does not set `test.globals: true` (setup.ts's own imports above are explicit
// `from "vitest"` for the same reason), so @testing-library/react's own auto-cleanup — which
// detects a global `afterEach` — never registers. Without this, DOM from every renderApp()/render()
// in an earlier `it()` in the same file stays mounted, and a later test's byTestId/byRole queries
// see duplicates. Register it once here for every test file in the package.
afterEach(cleanup);

// Node >=24's own experimental global `localStorage` (on by default on some builds, e.g. observed
// on 25.2.1) shadows jsdom's window.localStorage as a plain non-Storage object, silently breaking
// getItem/setItem/clear. package.json's test script sets NODE_OPTIONS=--no-experimental-webstorage
// so jsdom's real Storage implementation is what prefs.ts and this suite's localStorage.clear() see.

// jsdom implements neither of these; Mantine (useMantineColorScheme, ScrollArea) and React Flow
// (later tasks) require them. matchMedia mock is Mantine's own prescribed test setup.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
