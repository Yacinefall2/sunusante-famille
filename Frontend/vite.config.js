import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { serviceWorkerPlugin } from "./pwa/vitePlugin.js";

// https://vite.dev/config/
export default defineConfig({
  // serviceWorkerPlugin : publie /sw.js au build (mode hors ligne et
  // notifications push — voir pwa/service-worker.js). Pas de service worker
  // en développement (npm run dev).
  plugins: [react(), serviceWorkerPlugin()],
  server: {
    port: 5173,
    proxy: {
      // Redirige les appels /api/* vers le backend Express en dev
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
      // Redirige l'accès aux fichiers uploadés vers le backend Express en dev
      "/uploads": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});