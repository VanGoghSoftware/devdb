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
  const utils = render(
    <QueryClientProvider client={client}>
      <MantineProvider>
        <MemoryRouter initialEntries={[opts.route ?? "/"]}>{ui}</MemoryRouter>
      </MantineProvider>
    </QueryClientProvider>,
  );
  return { ...utils, client };
}
