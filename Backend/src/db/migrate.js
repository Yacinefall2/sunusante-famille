import "dotenv/config";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";

// Applique les migrations versionnées du dossier drizzle/ (générées par
// `npm run db:generate`). Remplace l'ancien `drizzle-kit push --force`, qui
// modifiait le schéma sans trace ni possibilité de relecture.
//
// Transition : une base créée par l'ancien `push` contient déjà les tables
// mais aucun historique de migrations. Dans ce cas (et seulement celui-là),
// on l'aligne une dernière fois sur le schéma avec `push`, puis on marque la
// migration initiale comme déjà appliquée pour que `migrate` ne tente pas de
// recréer des tables existantes.

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

export async function runMigrations(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error("DATABASE_URL est requis (voir le fichier .env.example)");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(`
      select
        to_regclass('public.users') is not null as has_tables,
        to_regclass('drizzle.__drizzle_migrations') is not null as has_history
    `);
    if (rows[0].has_tables && !rows[0].has_history) {
      console.log("ℹ️  Base créée par l'ancien drizzle-kit push : alignement puis adoption des migrations versionnées.");
      execSync("npx drizzle-kit push --force", { stdio: "inherit", env: { ...process.env, DATABASE_URL: databaseUrl } });
      const [initial] = readMigrationFiles({ migrationsFolder });
      await pool.query(`create schema if not exists drizzle`);
      await pool.query(
        `create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`
      );
      await pool.query(`insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`, [
        initial.hash,
        initial.folderMillis,
      ]);
    }
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

// Exécution directe : `node src/db/migrate.js` (utilisé par docker-entrypoint.sh)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => console.log("✅ Migrations appliquées"))
    .catch((err) => {
      console.error("❌ Échec des migrations :", err);
      process.exit(1);
    });
}
