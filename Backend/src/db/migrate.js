import "dotenv/config";
import path from "node:path";
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
// on vérifie qu'elle contient bien toutes les tables de la migration
// initiale, puis on marque celle-ci comme déjà appliquée ; les migrations
// suivantes s'appliquent ensuite normalement. Surtout pas de `push` ici : il
// alignerait la base sur le schéma ACTUEL et supprimerait des colonnes avant
// que les migrations suivantes n'aient converti leurs données.

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

// Au redémarrage de Docker, PostgreSQL peut accepter les connexions puis
// répondre « the database system is starting up » quelques secondes encore :
// on attend qu'il réponde vraiment (jusqu'à ~60 s) au lieu de planter.
async function waitForDatabase(pool, { attempts = 30, delayMs = 2000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      const notReady = error.code === "57P03" || ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(error.code);
      if (!notReady || i >= attempts) throw error;
      console.log(`⏳ Base de données pas encore prête (${error.code}), nouvel essai dans ${delayMs / 1000} s…`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function runMigrations(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error("DATABASE_URL est requis (voir le fichier .env.example)");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await waitForDatabase(pool);
    const { rows } = await pool.query(`
      select
        to_regclass('public.users') is not null as has_tables,
        to_regclass('drizzle.__drizzle_migrations') is not null as has_history
    `);
    if (rows[0].has_tables && !rows[0].has_history) {
      console.log("ℹ️  Base créée par l'ancien drizzle-kit push : adoption des migrations versionnées.");
      const [initial] = readMigrationFiles({ migrationsFolder });
      const expectedTables = [...initial.sql.join("\n").matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
      const missing = [];
      for (const table of expectedTables) {
        const { rows: found } = await pool.query(`select to_regclass($1) is not null as ok`, [`public.${table}`]);
        if (!found[0].ok) missing.push(table);
      }
      if (missing.length > 0) {
        throw new Error(`Base existante incomplète (tables absentes : ${missing.join(", ")}) — migration manuelle requise`);
      }
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
