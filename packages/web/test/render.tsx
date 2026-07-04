import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
}

export function renderApp(ui: ReactElement, opts: { route?: string; client?: QueryClient } = {}) {
  const client = opts.client ?? makeQueryClient();
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={client}>
      <MantineProvider>
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
