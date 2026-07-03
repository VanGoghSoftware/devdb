// jest-dom's built-in `vitest.d.ts` augments `declare module 'vitest'` but its augmentation does
// not merge under vitest 4 (its `Assertion` is re-exported from @vitest/expect, and jest-dom's
// relative `./matchers` import doesn't bind into our bundler-resolution program). We re-declare the
// augmentation here with a package-specifier import so it merges. Empirically the merge only lands
// when targeting the `vitest` module (the use-site specifier `app.test.tsx` imports `expect` from) —
// augmenting `@vitest/expect` directly does NOT take, because the assertion symbol at the call site
// is resolved through `vitest`'s namespace. (Runtime matchers still come from setup.ts's
// `import "@testing-library/jest-dom/vitest"`.)
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Assertion<T = unknown> extends TestingLibraryMatchers<T, void> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, void> {}
}
