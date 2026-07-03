// Runtime matcher registration. We do NOT use jest-dom's `import "@testing-library/jest-dom/vitest"`
// side-effect entry: from its spot in the pnpm store, jest-dom's own `require('vitest')` resolves to
// a stray vitest@3 copy hoisted by another workspace member, so it would call expect.extend on the
// WRONG expect and toBeInTheDocument would be undefined at our call sites. Instead register the raw
// matchers against THIS package's vitest-4 `expect` explicitly. (Types come from ./vitest.d.ts.)
import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

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
