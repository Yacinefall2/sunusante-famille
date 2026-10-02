import { defineConfig } from "vitest/config";

// Les tests tournent contre une vraie base PostgreSQL dédiée
// (santefamille_test), recréée à chaque lancement par test/globalSetup.js.
// Prérequis : `docker compose --profile test up -d db-test` à la racine du projet.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:55432/santefamille_test";

export default defineConfig({
  test: {
    globalSetup: "./test/globalSetup.js",
    // Une seule base partagée : les fichiers de test s'exécutent l'un après l'autre.
    fileParallelism: false,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_ACCESS_SECRET: "test_access_secret",
      JWT_REFRESH_SECRET: "test_refresh_secret",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1",
    },
  },
});
