import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@xyflow/react/dist/style.css";
import { router } from "./routes.js";
import { theme } from "./theme.js";
import { getThemePref } from "./prefs.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} defaultColorScheme={getThemePref()}>
        <Notifications position="top-right" />
        <RouterProvider router={router} />
      </MantineProvider>
    </QueryClientProvider>
  </StrictMode>,
);
