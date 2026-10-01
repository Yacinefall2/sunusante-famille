import "dotenv/config";

/** @type {import('drizzle-kit').Config} */
export default {
  dialect: "postgresql",
  schema: "./src/db/schema.js",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/santefamille",
  },
};
