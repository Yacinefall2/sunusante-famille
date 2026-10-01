import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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