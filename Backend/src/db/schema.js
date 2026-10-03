import {
  pgTable,
  serial,
  text,
  varchar,
  date,
  timestamp,
  boolean,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Familles ────────────────────────────────────────────────────────────────
export const families = pgTable("families", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Membres de la famille ─────────────────────────────────────────────────────
export const members = pgTable("members", {
  id: serial("id").primaryKey(),
  familyId: integer("family_id")
    .references(() => families.id, { onDelete: "cascade" })
    .notNull(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  dateOfBirth: date("date_of_birth"),
  gender: varchar("gender", { length: 20 }),
  bloodType: varchar("blood_type", { length: 10 }),
  allergies: text("allergies"),
  notes: text("notes"),
  avatarColor: varchar("avatar_color", { length: 20 }).default("#3B82F6"),
  // Axe 3 du modèle d'acteurs — statut de la personne. Détermine l'affichage
  // et le canal de notification, JAMAIS les droits d'accès (ceux-ci relèvent
  // de l'Axe 1 family_memberships.role et de l'Axe 2 document_roles).
  // Valeurs : connecte_autonome | connecte_assiste | adolescent | mineur_gere | non_connecte
  status: varchar("status", { length: 30 }).default("connecte_autonome").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Rôles sur un dossier (Axe 2 du modèle d'acteurs) ──────────────────────────
// Une même fiche peut avoir PLUSIEURS personnes avec des rôles différents et
// cumulables : Gestionnaire (R2), Relais (R3), Lecteur invité (R4). Le
// Titulaire (R1) n'est pas stocké ici : c'est le compte relié à la fiche
// (family_memberships.linkedMemberId). Une personne a au plus un rôle par fiche.
export const documentRoles = pgTable("document_roles", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id")
    .references(() => members.id, { onDelete: "cascade" })
    .notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  // "titulaire" (R1) | "gestionnaire" (R2) | "relais" (R3) | "lecteur_invite" (R4)
  role: varchar("role", { length: 30 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("document_roles_member_user_uq").on(t.memberId, t.userId)]);

// ── Rendez-vous ────────────────────────────────────────────────────────────────
export const appointments = pgTable("appointments", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id")
    .references(() => members.id, { onDelete: "cascade" })
    .notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  doctorName: varchar("doctor_name", { length: 255 }),
  location: varchar("location", { length: 255 }),
  appointmentDate: timestamp("appointment_date").notNull(),
  notes: text("notes"),
  status: varchar("status", { length: 50 }).default("upcoming").notNull(), // upcoming | completed | cancelled
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Traitements ────────────────────────────────────────────────────────────────
// Un traitement correspond à une maladie / un motif (ex. "Angine", "Diabète").
// Il peut regrouper plusieurs médicaments (voir treatmentMedications ci-dessous),
// chacun avec sa propre posologie, fréquence et durée.
export const treatments = pgTable("treatments", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id")
    .references(() => members.id, { onDelete: "cascade" })
    .notNull(),
  disease: varchar("disease", { length: 255 }).notNull(), // maladie / motif du traitement
  startDate: date("start_date"),
  endDate: date("end_date"),
  prescribedBy: varchar("prescribed_by", { length: 255 }),
  isActive: boolean("is_active").default(true).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Médicaments d'un traitement ─────────────────────────────────────────────
export const treatmentMedications = pgTable("treatment_medications", {
  id: serial("id").primaryKey(),
  treatmentId: integer("treatment_id")
    .references(() => treatments.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  dosage: varchar("dosage", { length: 100 }),
  frequency: varchar("frequency", { length: 100 }),
  duration: varchar("duration", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Vaccinations ────────────────────────────────────────────────────────────────
export const vaccinations = pgTable("vaccinations", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id")
    .references(() => members.id, { onDelete: "cascade" })
    .notNull(),
  vaccineName: varchar("vaccine_name", { length: 255 }).notNull(),
  dateAdministered: date("date_administered").notNull(),
  nextDoseDate: date("next_dose_date"),
  administeredBy: varchar("administered_by", { length: 255 }),
  lotNumber: varchar("lot_number", { length: 100 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Documents médicaux ────────────────────────────────────────────────────────
export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id")
    .references(() => members.id, { onDelete: "cascade" })
    .notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  documentType: varchar("document_type", { length: 100 }).notNull(),
  description: text("description"),
  fileUrl: text("file_url"),
  originalName: varchar("original_name", { length: 255 }),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
});

// ── Utilisateurs (comptes de connexion) ───────────────────────────────────────
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  name: varchar("name", { length: 150 }).notNull(),
  // Un compte n'accède à rien (créer un espace, consulter, saisir) tant que
  // cette adresse n'a pas été vérifiée via le lien reçu par courriel —
  // règle transverse §10, sans exception (inscription comme invitation).
  emailVerified: boolean("email_verified").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Jetons de vérification d'adresse courriel ────────────────────────────────
// À usage unique et à durée limitée (règle transverse §10 "Liens à usage
// unique"). Un nouveau jeton remplace le précédent à chaque renvoi (UC-62).
export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  token: varchar("token", { length: 255 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Appartenance à une famille + rôle (le rôle est par famille, pas global) ──
export const familyMemberships = pgTable("family_memberships", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  familyId: integer("family_id")
    .references(() => families.id, { onDelete: "cascade" })
    .notNull(),
  // "parent" | "adult" | "dependent" — les rôles d'accès temporaire (médecin
  // invité, agent de santé, urgentiste) seront gérés par une table dédiée
  // à une étape ultérieure (accès avec expiration automatique).
  role: varchar("role", { length: 30 }).notNull().default("adult"),
  // Axe 1 du modèle d'acteurs — distingue A1 (Administrateur familial, celui
  // qui a créé l'espace) de A2 (Co-administrateur). Seul A1 peut supprimer
  // l'espace, promouvoir un co-administrateur, ou être retiré par personne
  // d'autre que lui-même. true uniquement pour le créateur de la famille.
  isPrimaryAdmin: boolean("is_primary_admin").default(false).notNull(),
  // Fiche de la personne elle-même (« ma fiche ») : ce compte en est le
  // Titulaire (R1). Valable pour tous les rôles ; obligatoire pour un
  // "dependent", qui ne voit que cette fiche. Une fiche n'est reliée qu'à un
  // seul compte.
  linkedMemberId: integer("linked_member_id").references(() => members.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("family_memberships_linked_member_uq").on(t.linkedMemberId).where(sql`${t.linkedMemberId} is not null`),
]);

// ── Refresh tokens (permet la révocation au logout + la rotation) ────────────
export const refreshTokens = pgTable("refresh_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  tokenHash: varchar("token_hash", { length: 255 }).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Invitations en attente (accès à une famille par email, avec jeton) ───────
export const pendingInvitations = pgTable("pending_invitations", {
  id: serial("id").primaryKey(),
  familyId: integer("family_id")
    .references(() => families.id, { onDelete: "cascade" })
    .notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  // "parent" | "adult" | "dependent"
  role: varchar("role", { length: 30 }).notNull().default("adult"),
  // Fiche de la personne invitée (« sa fiche »), choisie par un Parent —
  // obligatoire si role = "dependent", optionnelle sinon. Reportée sur
  // family_memberships.linkedMemberId au moment de l'acceptation.
  linkedMemberId: integer("linked_member_id").references(() => members.id, { onDelete: "set null" }),
  // Rôle Axe 2 (Gestionnaire/Relais/Lecteur invité) proposé sur un
  // dossier précis, fixé AVANT l'envoi comme le rôle d'espace (§6.2/6.3) —
  // reporté dans document_roles au moment de l'acceptation. Optionnel : une
  // invitation peut ne concerner que le rôle d'espace.
  documentMemberId: integer("document_member_id").references(() => members.id, { onDelete: "set null" }),
  documentRole: varchar("document_role", { length: 30 }),
  token: varchar("token", { length: 255 }).notNull().unique(),
  invitedByUserId: integer("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});