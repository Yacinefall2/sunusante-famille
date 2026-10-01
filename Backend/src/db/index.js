import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL est requis (voir le fichier .env.example)");
}

export const pool = new Pool({
  connectionString: databaseUrl,
});

export const db = drizzle(pool);
