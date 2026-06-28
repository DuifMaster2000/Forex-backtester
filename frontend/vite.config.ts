import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so built asset URLs work under the GitHub Pages project subpath
// (https://<user>.github.io/Forex-backtester/) without hardcoding the repo name.
// The app is fully client-side, so no dev proxy/backend is needed.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173 },
  // The optimiser spreads work across ES-module Web Workers.
  worker: { format: "es" },
});
