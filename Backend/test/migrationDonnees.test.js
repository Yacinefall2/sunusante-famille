import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import pg from "pg";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { runMigrations } from "../src/db/migrate.js";

// Vérifie la reprise d'une base créée par l'ancien `drizzle-kit push` (schéma
// de la migration 0000, sans historique) et la conversion des données de la
// migration 0001 : guardianUserId → Gestionnaire, « titulaire » → fiche reliée.
const baseUrl = new URL(process.env.DATABASE_URL);
const dbName = "santefamille_migration_test";
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const legacyUrl = new URL(baseUrl);
legacyUrl.pathname = `/${dbName}`;

let client;
const q = async (sql, params) => (await client.query(sql, params)).rows;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`drop database if exists "${dbName}" with (force)`);
  await admin.query(`create database "${dbName}"`);
  await admin.end();

  client = new pg.Client({ connectionString: legacyUrl.toString() });
  await client.connect();
  const [initial] = readMigrationFiles({ migrationsFolder: path.join(import.meta.dirname, "..", "drizzle") });
  for (const statement of initial.sql) await client.query(statement);

  // Données « à l'ancienne » (reprend le cas réel de la base de développement).
  await q(`insert into families (id, name) values (1, 'Fall')`);
  await q(`insert into users (id, email, password_hash, name, email_verified) values
    (1, 'yacine@t', 'x', 'yacine', true),
    (2, 'zahra@t', 'x', 'zahra', true),
    (3, 'yass@t', 'x', 'yassfall', true),
    (4, 'ibra@t', 'x', 'Ibrahima', true),
    (5, 'awa@t', 'x', 'awa', true)`);
  await q(`insert into family_memberships (user_id, family_id, role, is_primary_admin) values
    (1, 1, 'parent', true), (2, 1, 'parent', false), (3, 1, 'adult', false), (4, 1, 'adult', false), (5, 1, 'adult', false)`);
  await q(`insert into members (id, family_id, first_name, last_name, guardian_user_id) values
    (4, 1, 'Mouhamed', 'FALL', null),
    (5, 1, 'Yacine', 'Fall', 1),
    (6, 1, 'zahra', 'FALL', 1),
    (7, 1, 'Ibrahima', 'Ndiaye', null),
    (8, 1, 'Awa', 'Diop', null),
    (9, 1, 'Awa', 'Sow', null)`);
  await q(`insert into document_roles (member_id, user_id, role) values
    (5, 1, 'gestionnaire'), (4, 1, 'titulaire'), (6, 2, 'titulaire')`);

  await runMigrations(legacyUrl.toString());
});

afterAll(async () => {
  await client?.end();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`drop database if exists "${dbName}" with (force)`);
  await admin.end();
});

describe("Migration 0001 sur une base existante", () => {
  it("relie chaque compte à sa fiche : rôle titulaire d'abord, puis nom sans ambiguïté", async () => {
    const rows = await q(`select user_id, linked_member_id from family_memberships order by user_id`);
    expect(Object.fromEntries(rows.map((r) => [r.user_id, r.linked_member_id]))).toEqual({
      1: 4, // titulaire de Mouhamed FALL (priorité sur le rapprochement par nom)
      2: 6, // titulaire de zahra FALL
      3: null, // aucune fiche correspondante : choisira à la connexion
      4: 7, // « Ibrahima » ↔ Ibrahima Ndiaye
      5: null, // « awa » ambigu (Awa Diop / Awa Sow) : pas de rapprochement
    });
  });

  it("transforme le créateur d'une fiche en Gestionnaire et supprime le rôle titulaire", async () => {
    const rows = await q(`select member_id, user_id, role from document_roles order by member_id, user_id`);
    expect(rows).toEqual([
      { member_id: 5, user_id: 1, role: "gestionnaire" },
      { member_id: 6, user_id: 1, role: "gestionnaire" },
    ]);
  });

  it("supprime la colonne guardian_user_id et enregistre les deux migrations", async () => {
    const cols = await q(`select column_name from information_schema.columns where table_name = 'members'`);
    expect(cols.map((c) => c.column_name)).not.toContain("guardian_user_id");
    const applied = await q(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(applied[0].n).toBe(readMigrationFiles({ migrationsFolder: path.join(import.meta.dirname, "..", "drizzle") }).length);
  });
});
