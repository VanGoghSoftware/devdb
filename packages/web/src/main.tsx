import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider, localStorageColorSchemeManager } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@xyflow/react/dist/style.css";
import { router } from "./routes.js";
import { theme } from "./theme.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});

// Single source of truth for the color scheme: Mantine's own manager reads/writes the SAME
// `devdb.theme` key that prefs.ts's getThemePref/setThemePref use, so the shell's toggle (which
// calls Mantine's setColorScheme) and prefs.ts never diverge. defaultColorScheme="auto" is only
// the fallback used when the key is absent from storage.
const colorSchemeManager = localStorageColorSchemeManager({ key: "devdb.theme" });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} defaultColorScheme="auto" colorSchemeManager={colorSchemeManager}>
        <Notifications position="top-right" />
        <RouterProvider router={router} />
      </MantineProvider>
    </QueryClientProvider>
  </StrictMode>,
);
