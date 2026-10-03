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
  // Coordonnées (M2, UC-13) et contact d'urgence (fiche d'urgence, §5).
  // Données du dossier : visibles seulement des comptes qui le lisent.
  phone: varchar("phone", { length: 30 }),
  doctorName: varchar("doctor_name", { length: 150 }),
  doctorPhone: varchar("doctor_phone", { length: 30 }),
  emergencyContactName: varchar("emergency_contact_name", { length: 150 }),
  emergencyContactRelation: varchar("emergency_contact_relation", { length: 60 }),
  emergencyContactPhone: varchar("emergency_contact_phone", { length: 30 }),
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
  // Statut (M3) : pending (en attente) | confirmed (confirmé) | cancelled (annulé)
  status: varchar("status", { length: 50 }).default("pending").notNull(),
  // Présence, renseignée une fois la date passée (UC-18, UC-33) :
  // attended (s'y est rendu) | missed (n'y est pas allé) | null (non renseignée)
  attendance: varchar("attendance", { length: 20 }),
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
  // Heures de prise au format HH:MM (ex. {"08:00","20:00"}) — base des
  // rappels de prise (UC-56). La fréquence texte reste un complément libre.
  intakeTimes: text("intake_times").array().default(sql`'{}'::text[]`).notNull(),
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
  // Auteur du document (UC-15 : suppression par l'auteur ou le titulaire).
  // NULL pour les documents ajoutés avant l'enregistrement de l'auteur.
  uploadedByUserId: integer("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // Document confidentiel (UC-16) : visible seulement du titulaire du
  // dossier et de l'Administrateur familial A1 (§10).
  isConfidential: boolean("is_confidential").default(false).notNull(),
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
// ── Prises de médicament (UC-20, UC-44, UC-56) ────────────────────────────────
// Une ligne par prise prévue (médicament × jour × heure), créée par le moteur
// de rappels à l'heure dite. La réponse « pris » / « pas pris » est gardée :
// c'est l'historique de prise du traitement.
export const medicationIntakes = pgTable(
  "medication_intakes",
  {
    id: serial("id").primaryKey(),
    medicationId: integer("medication_id")
      .references(() => treatmentMedications.id, { onDelete: "cascade" })
      .notNull(),
    memberId: integer("member_id")
      .references(() => members.id, { onDelete: "cascade" })
      .notNull(),
    scheduledAt: timestamp("scheduled_at").notNull(),
    // pending (en attente de réponse) | taken (pris) | not_taken (pas pris) | missed (sans réponse)
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    respondedByUserId: integer("responded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    respondedAt: timestamp("responded_at"),
    remindedAt: timestamp("reminded_at"),
    followUpAt: timestamp("follow_up_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("medication_intakes_medication_time_uq").on(t.medicationId, t.scheduledAt)]
);

// ── Notifications (M7 — dans l'application et par courriel, §7) ──────────────
// Une ligne par notification et par destinataire. dedupeKey garantit qu'un
// même rappel n'est jamais créé deux fois, même si le moteur repasse.
export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    familyId: integer("family_id").references(() => families.id, { onDelete: "cascade" }),
    memberId: integer("member_id").references(() => members.id, { onDelete: "cascade" }),
    // appointment_reminder | medication_intake | vaccine_reminder | delivery_failure
    category: varchar("category", { length: 40 }).notNull(),
    dedupeKey: varchar("dedupe_key", { length: 200 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body"),
    // Chemin de l'application à ouvrir depuis la notification (ex. /rendez-vous)
    link: varchar("link", { length: 255 }),
    intakeId: integer("intake_id").references(() => medicationIntakes.id, { onDelete: "cascade" }),
    // Visible dans la cloche (préférence « application » de la catégorie)
    inApp: boolean("in_app").default(true).notNull(),
    readAt: timestamp("read_at"),
    // Courriel : skipped (non demandé) | pending | sent | failed
    emailStatus: varchar("email_status", { length: 20 }).default("skipped").notNull(),
    emailAttempts: integer("email_attempts").default(0).notNull(),
    emailNextAttemptAt: timestamp("email_next_attempt_at"),
    emailLastError: text("email_last_error"),
    emailMessageId: varchar("email_message_id", { length: 255 }),
    emailSentAt: timestamp("email_sent_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("notifications_dedupe_uq").on(t.dedupeKey)]
);

// ── Préférences de notification (UC-65) ──────────────────────────────────────
// Une ligne par compte et par catégorie — jamais d'interrupteur global (§7.3).
// Sans ligne, les valeurs par défaut de lib/notificationPreferences.js s'appliquent.
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    category: varchar("category", { length: 40 }).notNull(),
    inApp: boolean("in_app").notNull(),
    email: boolean("email").notNull(),
  },
  (t) => [uniqueIndex("notification_preferences_user_category_uq").on(t.userId, t.category)]
);
