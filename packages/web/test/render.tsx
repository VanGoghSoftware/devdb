import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MantineProvider, Popover, createTheme } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
}

// Test-only theme: disable Popover's `hideDetached`, which every dropdown-bearing component
// (Menu, Select/Combobox, HoverCard…) inherits — Menu forwards nothing, so its inner Popover reads
// this default. WHY: Floating UI's hide() middleware measures the trigger with getBoundingClientRect,
// which jsdom always reports as an all-zero rect, so it intermittently flags the reference "hidden".
// Mantine then paints the OPEN dropdown `display: none` (PopoverDropdown.mjs, gated by
// `hideDetached && env !== "test" ? hide.referenceHidden : false` in Popover.mjs) — the items are
// mounted with opacity:1 and a resolved position but drop out of the a11y tree, so
// findByRole("menuitem") times out. It only bites under full-suite CPU load (~9 forks / 10 cores),
// never in isolation — reproduced + root-caused 2026-07-04 (menu items present, only display:none).
// Setting hideDetached:false forces referenceHidden:false without env="test": we deliberately keep
// transitions ASYNC so the two waitForElementToBeRemoved() modal-close assertions still see the
// element before it unmounts (env="test" makes exits synchronous and breaks them).
const testTheme = createTheme({
  components: { Popover: Popover.extend({ defaultProps: { hideDetached: false } }) },
});

export function renderApp(ui: ReactElement, opts: { route?: string; client?: QueryClient } = {}) {
  const client = opts.client ?? makeQueryClient();
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={client}>
      <MantineProvider theme={testTheme}>
        <MemoryRouter initialEntries={[opts.route ?? "/"]}>{node}</MemoryRouter>
      </MantineProvider>
    </QueryClientProvider>
  );
  const utils = render(wrap(ui));
  // testing-library's own `utils.rerender(node)` re-renders ONLY `node` — it does not repeat the
  // provider wrapping from the initial `render()` call — so swapping in a bare `<Component .../>`
  // there would unmount out from under QueryClientProvider/MantineProvider/MemoryRouter and throw
  // ("No QueryClient set"). Shadow it with a version that re-wraps, so callers that need to change
  // props on the SAME mounted instance (e.g. simulating a parent passing a new `branchId`) can do
  // so without reaching for the raw testing-library export.
  return { ...utils, client, rerender: (node: ReactElement) => utils.rerender(wrap(node)) };
}
