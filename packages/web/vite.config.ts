import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev mode: the daemon owns :4400; Vite serves the SPA and proxies API + MCP so no CORS
    // surface is ever added to the daemon. SSE streams through http-proxy unbuffered by default —
    // do NOT add compression middleware here (it would buffer /api/events and the log tails).
    proxy: {
      "/api": { target: "http://localhost:4400", changeOrigin: true },
      "/mcp": { target: "http://localhost:4400", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});
