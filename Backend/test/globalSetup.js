import pg from "pg";
import { runMigrations } from "../src/db/migrate.js";

// Recrée la base de test à vide puis applique toutes les migrations depuis
// zéro — ce qui vérifie aussi, à chaque lancement, que les migrations
// versionnées construisent bien le schéma complet.
export default async function setup() {
  const testUrl =
    process.env.TEST_DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:55432/santefamille_test";
  const url = new URL(testUrl);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refus de recréer "${dbName}" : le nom d'une base de test doit finir par _test`);
  }

  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`drop database if exists "${dbName}" with (force)`);
  await admin.query(`create database "${dbName}"`);
  await admin.end();

  await runMigrations(testUrl);
}
