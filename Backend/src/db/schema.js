import {
  pgTable,
  serial,
  text,
  varchar,
  date,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  index,
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
  // Lien de parenté avec les parents du foyer (les administrateurs). Le
  // libellé affiché (« petit frère », « grand-mère », « neveu »…) est calculé
  // pour chaque personne qui regarde, à partir de ce lien, du sexe et de la
  // date de naissance (lib/kinship côté interface).
  // parent | enfant | petit_enfant | grand_parent | oncle_tante | neveu_niece | cousin | autre
  kinship: varchar("kinship", { length: 30 }),
  // Membre par qui passe le lien : le parent dont c'est le père ou la mère
  // (grand_parent), le frère ou la sœur (oncle_tante) ; l'enfant dont c'est
  // l'enfant (petit_enfant)… Optionnel.
  kinshipRelatedMemberId: integer("kinship_related_member_id").references(() => members.id, { onDelete: "set null" }),
  // Fiche archivée (gelée) : le compte adulte qui en était le titulaire a
  // quitté la famille (retiré de l'espace ou compte supprimé). Plus aucun
  // accès pour personne, plus de rappels ; seul A1 peut la supprimer. Elle
  // est rendue à son ancien titulaire s'il rejoint de nouveau la famille
  // (lib/archive.js).
  archivedAt: timestamp("archived_at"),
  archivedUserId: integer("archived_user_id").references(() => users.id, { onDelete: "set null" }),
  // Motif de l'archivage : "departure" (le titulaire a quitté la famille) |
  // "consent_withdrawn" (le proche sans compte a retiré son accord oral, UC-29).
  // Seule une fiche archivée pour retrait d'accord peut être réactivée par
  // un parent, au moyen d'une nouvelle attestation.
  archivedReason: varchar("archived_reason", { length: 30 }),
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
  // Fin de l'accès — obligatoire pour un Lecteur invité (R4, « consultation
  // seule, durée limitée »), NULL pour les autres rôles. Un rôle échu est
  // ignoré par le moteur d'accès, puis supprimé par le worker
  // (reminders/roles.js) ; prolongeable par qui gère les rôles de la fiche.
  expiresAt: timestamp("expires_at", { precision: 3 }),
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
  // Précision à la milliseconde, comme les dates JavaScript : une date
  // relue doit être strictement égale à celle écrite (tâches du Village).
  appointmentDate: timestamp("appointment_date", { precision: 3 }).notNull(),
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
  // Suivi du rappel : la vaccination qui l'a effectué (bouton « Rappel
  // effectué »). Statut affiché : à faire / en retard / fait (routes/vaccinations.js).
  boosterDoneVaccinationId: integer("booster_done_vaccination_id").references(() => vaccinations.id, {
    onDelete: "set null",
  }),
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
  // NULL pour un compte créé avec « Continuer avec Google » qui n'a pas
  // (encore) choisi de mot de passe : la connexion par mot de passe lui est
  // alors impossible (même refus générique qu'un mauvais mot de passe).
  passwordHash: varchar("password_hash", { length: 255 }),
  name: varchar("name", { length: 150 }).notNull(),
  // Un compte n'accède à rien (créer un espace, consulter, saisir) tant que
  // cette adresse n'a pas été vérifiée via le lien reçu par courriel —
  // règle transverse §10, sans exception (inscription comme invitation).
  emailVerified: boolean("email_verified").default(false).notNull(),
  // Dernier changement de mot de passe : toute session ouverte avant est
  // refusée (requireAuth), y compris un jeton d'accès encore valide.
  passwordChangedAt: timestamp("password_changed_at"),
  // Mode senior (UC-25, M10) : réglage d'AFFICHAGE du compte (grands
  // caractères, accueil simplifié, alertes sonores) — jamais un rôle, sans
  // AUCUN effet sur les droits (ne pas l'utiliser dans lib/documentAccess.js).
  // Activable par la personne elle-même ou par un parent de sa famille ; on
  // garde qui l'a changé en dernier, et quand.
  seniorMode: boolean("senior_mode").default(false).notNull(),
  seniorModeSetByUserId: integer("senior_mode_set_by_user_id").references(() => users.id, { onDelete: "set null" }),
  seniorModeUpdatedAt: timestamp("senior_mode_updated_at"),
  // Dernière connexion réussie (métadonnée technique, visible du support).
  lastLoginAt: timestamp("last_login_at"),
  // Suspension par le support (UC-52) : blocage TEMPORAIRE et RÉVERSIBLE
  // d'un compte signalé. Connexion et sessions refusées ; données, fiche et
  // rôles intacts. suspended_until NULL = jusqu'à nouvel ordre ; à cette
  // date, le worker lève la suspension (lib/suspension.js).
  suspendedAt: timestamp("suspended_at", { precision: 3 }),
  suspendedUntil: timestamp("suspended_until", { precision: 3 }),
  suspensionReason: text("suspension_reason"),
  suspendedBy: integer("suspended_by").references(() => supportUsers.id, { onDelete: "set null" }),
  // Connexion avec Google : identifiant Google stable (champ « sub » du jeton
  // d'identité vérifié), jamais l'adresse — elle peut changer côté Google.
  // Seules données Google conservées : cet identifiant, l'adresse et le nom.
  googleSub: varchar("google_sub", { length: 255 }).unique(),
  googleLinkedAt: timestamp("google_linked_at", { precision: 3 }),
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

// ── Jetons de réinitialisation du mot de passe ───────────────────────────────
// Lien « Mot de passe oublié » : à usage unique, valable 1 heure ; seule
// l'empreinte du jeton est conservée. Une nouvelle demande annule les
// précédentes.
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Inscription avec Google, en attente de confirmation ─────────────────────
// Premier passage d'une personne inconnue par « Continuer avec Google » : le
// compte n'est PAS créé tout de suite. Ce jeton (empreinte seule, 15 minutes,
// usage unique) retient l'identité Google VÉRIFIÉE le temps qu'elle confirme
// son nom et accepte les conditions. Lié à une invitation quand l'inscription
// part de « Accepter avec Google ».
export const googleSignupTokens = pgTable("google_signup_tokens", {
  id: serial("id").primaryKey(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  googleSub: varchar("google_sub", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  name: varchar("name", { length: 150 }).notNull(),
  invitationId: integer("invitation_id").references(() => pendingInvitations.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { precision: 3 }).notNull(),
  consumedAt: timestamp("consumed_at", { precision: 3 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Changement d'adresse courriel ────────────────────────────────────────────
// La nouvelle adresse ne remplace l'ancienne qu'une fois le lien envoyé à
// celle-ci suivi (preuve qu'elle appartient bien à la personne). Valable
// 24 heures, à usage unique, empreinte seule conservée.
export const emailChangeTokens = pgTable("email_change_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  newEmail: varchar("new_email", { length: 255 }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

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
  // Durée de l'accès d'un Lecteur invité ("7j" | "30j" | "3m" | "1a") :
  // l'échéance court à partir de l'acceptation de l'invitation.
  documentRoleDuration: varchar("document_role_duration", { length: 5 }),
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
    // | relay_to_relay | relay_escalation | relay_alert | relay_update (Village)
    // | doctor_share | emergency_view (partage) — voir lib/notificationPreferences.js
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
    // Notification push vers les appareils abonnés (lib/push.js) :
    // skipped (catégorie non concernée, ou pas dans l'application) | pending | sent | failed
    pushStatus: varchar("push_status", { length: 20 }).default("skipped").notNull(),
    pushSentAt: timestamp("push_sent_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("notifications_dedupe_uq").on(t.dedupeKey),
    index("notifications_push_pending_idx").on(t.id).where(sql`${t.pushStatus} = 'pending'`),
  ]
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

// ── Village : rappels relayés vers un proche non connecté (§4, UC-28 à 42) ────
// Une tâche par rendez-vous (et par date) d'une fiche « non connecté ». Le
// proche ne voit jamais l'application : la tâche pilote une action humaine
// (l'appel téléphonique) et en garde la trace.
export const relayTasks = pgTable(
  "relay_tasks",
  {
    id: serial("id").primaryKey(),
    appointmentId: integer("appointment_id")
      .references(() => appointments.id, { onDelete: "cascade" })
      .notNull(),
    memberId: integer("member_id")
      .references(() => members.id, { onDelete: "cascade" })
      .notNull(),
    familyId: integer("family_id")
      .references(() => families.id, { onDelete: "cascade" })
      .notNull(),
    appointmentDate: timestamp("appointment_date", { precision: 3 }).notNull(),
    // J-3 : « à relayer » envoyé au(x) gestionnaire(s)
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // J-1 : relance au(x) gestionnaire(s) ; +3 h : escalade vers les relais
    followUpAt: timestamp("follow_up_at"),
    escalatedAt: timestamp("escalated_at"),
    // « Prévenu » : clôt la tâche pour tout le monde (gestionnaire ou relais)
    notifiedAt: timestamp("notified_at"),
    notifiedByUserId: integer("notified_by_user_id").references(() => users.id, { onDelete: "set null" }),
    // 12 h après le rendez-vous (ATTENDANCE_PROMPT_AFTER) : demande au
    // gestionnaire si le proche s'y est rendu
    attendancePromptAt: timestamp("attendance_prompt_at"),
  },
  (t) => [uniqueIndex("relay_tasks_appointment_date_uq").on(t.appointmentId, t.appointmentDate)]
);

// Historique horodaté des relais (UC-36, §10 « Traçabilité »).
// type : to_relay | follow_up | escalated | no_relay | notified | unreachable |
//        attended | missed | cancelled | moved (rendez-vous annulé ou déplacé)
export const relayEvents = pgTable("relay_events", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id")
    .references(() => relayTasks.id, { onDelete: "cascade" })
    .notNull(),
  type: varchar("type", { length: 30 }).notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Partage avec un professionnel de santé (A4, UC-22/23/37, UC-45 à 47) ─────
// Lien à usage unique et à durée limitée (§10) : la première ouverture le
// « consomme » et ouvre une consultation sur cet appareil jusqu'à
// l'expiration ; toute autre ouverture est refusée et signalée.
export const doctorShares = pgTable("doctor_shares", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id")
    .references(() => members.id, { onDelete: "cascade" })
    .notNull(),
  familyId: integer("family_id")
    .references(() => families.id, { onDelete: "cascade" })
    .notNull(),
  createdByUserId: integer("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  // Éléments partagés, choisis à la création (UC-22)
  includeEssentials: boolean("include_essentials").default(true).notNull(), // groupe sanguin, allergies, médecin traitant
  includeTreatments: boolean("include_treatments").default(false).notNull(),
  includeVaccinations: boolean("include_vaccinations").default(false).notNull(),
  documentIds: integer("document_ids").array().default(sql`'{}'::integer[]`).notNull(),
  // Adresse du médecin : le lien lui est envoyé par courriel, il n'est
  // jamais affiché à la famille. Vide pour les liens créés avant ce choix.
  doctorEmail: varchar("doctor_email", { length: 255 }),
  expiresAt: timestamp("expires_at").notNull(),
  // Révocation depuis l'application (routes/doctorShares.js) : le lien cesse
  // de fonctionner immédiatement, même déjà ouvert.
  revokedAt: timestamp("revoked_at"),
  consumedAt: timestamp("consumed_at"),
  sessionHash: varchar("session_hash", { length: 64 }),
  lastViewedAt: timestamp("last_viewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Fiche d'urgence (A6, UC-24/38/48/49, §5) ─────────────────────────────────
// Une par fiche. Rien n'est publié tant que le titulaire (ou le gestionnaire
// d'un proche sans compte) n'a pas coché chaque information et activé la
// fiche. Le jeton est imprimé dans le QR code : le régénérer invalide
// l'ancienne carte.
//
// Le jeton n'est plus stocké en clair : son empreinte SHA-256 (token_hash)
// sert à retrouver la fiche depuis le QR code, et une copie chiffrée
// (token_encrypted, AES-256-GCM, voir lib/sharing.js) permet au titulaire de
// réafficher son QR code. La colonne token ne contient plus que d'anciens
// jetons en attente de conversion (faite par l'application), puis NULL.
export const emergencyCards = pgTable("emergency_cards", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id")
    .references(() => members.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  token: varchar("token", { length: 64 }).unique(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  tokenEncrypted: text("token_encrypted"),
  active: boolean("active").default(false).notNull(),
  showAge: boolean("show_age").default(false).notNull(),
  showBloodType: boolean("show_blood_type").default(false).notNull(),
  showAllergies: boolean("show_allergies").default(false).notNull(),
  showTreatments: boolean("show_treatments").default(false).notNull(),
  showEmergencyContact: boolean("show_emergency_contact").default(false).notNull(),
  showDoctor: boolean("show_doctor").default(false).notNull(),
  // Informations utiles en urgence, rédigées par le titulaire (ex. « diabétique »)
  extraInfo: text("extra_info"),
  updatedByUserId: integer("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Consultations de la fiche d'urgence (traçabilité ; le titulaire est prévenu).
export const emergencyCardViews = pgTable("emergency_card_views", {
  id: serial("id").primaryKey(),
  cardId: integer("card_id")
    .references(() => emergencyCards.id, { onDelete: "cascade" })
    .notNull(),
  viewedAt: timestamp("viewed_at").defaultNow().notNull(),
});

// ── Journal d'activité (UC-10, §10 « Traçabilité », §6.3) ────────────────────
// Qui a fait quoi dans l'espace familial : invitations, rôles, fiches,
// partages, fiche d'urgence, Village. JAMAIS de donnée médicale (ni nom de
// médicament, ni motif de rendez-vous, ni titre de document) : seulement des
// faits de gouvernance, rédigés par lib/activityLog.js.
//
// Ineffaçable : aucune route ne modifie ni ne supprime une entrée, et un
// déclencheur PostgreSQL (migration 0015) refuse toute modification. Les
// entrées ne disparaissent qu'avec la famille (ON DELETE CASCADE).
//
// Les noms sont des INSTANTANÉS pris au moment de l'action : un compte
// supprimé (identifiant remis à NULL par la base) reste nommé, et une fiche
// supprimée garde son identifiant (member_id volontairement SANS clé
// étrangère) et son nom.
export const activityLog = pgTable(
  "activity_log",
  {
    id: serial("id").primaryKey(),
    familyId: integer("family_id")
      .references(() => families.id, { onDelete: "cascade" })
      .notNull(),
    occurredAt: timestamp("occurred_at", { precision: 3 }).defaultNow().notNull(),
    // Auteur de l'action (NULL : l'application elle-même, un médecin, un inconnu)
    actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorName: varchar("actor_name", { length: 150 }),
    // Type d'action : voir ACTIONS dans lib/activityLog.js
    action: varchar("action", { length: 60 }).notNull(),
    // Fiche concernée (sert aussi aux règles de visibilité)
    memberId: integer("member_id"),
    memberName: varchar("member_name", { length: 210 }),
    // Compte visé par l'action (rôle attribué, compte retiré…)
    targetUserId: integer("target_user_id").references(() => users.id, { onDelete: "set null" }),
    targetName: varchar("target_name", { length: 150 }),
    // Données non médicales structurées : rôle, durée, adresse invitée, champs publiés…
    details: jsonb("details"),
  },
  (t) => [
    index("activity_log_family_occurred_idx").on(t.familyId, t.occurredAt.desc(), t.id.desc()),
    index("activity_log_member_idx").on(t.memberId),
  ]
);

// ── Attestations de consentement oral (UC-28, UC-29, écran n°6, §10) ────────
// À la création du dossier d'un proche majeur sans compte, le déclarant
// (gestionnaire, parent) atteste sur l'honneur avoir obtenu l'accord oral de
// ce proche. Chaque ligne est un ENGAGEMENT horodaté : une attestation, ou le
// retrait de l'accord signalé par la famille (la fiche est alors archivée).
//
// Insertion seule : un déclencheur PostgreSQL (migration 0016) refuse toute
// modification. Les lignes ne disparaissent qu'avec la fiche ou la famille
// (ON DELETE CASCADE). Les noms sont des INSTANTANÉS pris au moment de
// l'engagement : un compte supprimé depuis reste nommé.
export const consentAttestations = pgTable(
  "consent_attestations",
  {
    id: serial("id").primaryKey(),
    familyId: integer("family_id")
      .references(() => families.id, { onDelete: "cascade" })
      .notNull(),
    memberId: integer("member_id")
      .references(() => members.id, { onDelete: "cascade" })
      .notNull(),
    // Nom du proche au moment de l'engagement
    memberName: varchar("member_name", { length: 210 }).notNull(),
    // "attestation" (accord obtenu) | "withdrawal" (accord retiré)
    kind: varchar("kind", { length: 20 }).notNull(),
    // Déclarant : compte connecté (NULL si ce compte a été supprimé depuis)
    // et nom de ce compte au moment de l'engagement
    declarantUserId: integer("declarant_user_id").references(() => users.id, { onDelete: "set null" }),
    declarantName: varchar("declarant_name", { length: 150 }).notNull(),
    // Signature : nom complet retapé par le déclarant (attestation seulement)
    signedName: varchar("signed_name", { length: 150 }),
    // Manière dont l'accord a été obtenu : en_personne | telephone | intermediaire
    method: varchar("method", { length: 20 }),
    // Proche par l'intermédiaire de qui l'accord a été recueilli
    intermediaryName: varchar("intermediary_name", { length: 150 }),
    // Date de l'accord oral, déclarée par le déclarant
    obtainedOn: date("obtained_on"),
    // Version du texte d'engagement affiché (lib/consent.js)
    textVersion: varchar("text_version", { length: 30 }),
    // Horodatage serveur (date ET heure) de l'engagement
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (t) => [index("consent_attestations_member_idx").on(t.memberId, t.createdAt.desc())]
);

// ── Transferts de gestion d'un dossier (UC-39) ───────────────────────────────
// Un gestionnaire (ou un parent ayant l'accès complet) propose à un autre
// compte adulte de la famille de reprendre la gestion d'une fiche ; le
// destinataire accepte ou refuse. Une seule proposition en attente par fiche.
// statut : pending | accepted | declined | cancelled | expired
export const roleTransfers = pgTable(
  "role_transfers",
  {
    id: serial("id").primaryKey(),
    familyId: integer("family_id")
      .references(() => families.id, { onDelete: "cascade" })
      .notNull(),
    memberId: integer("member_id")
      .references(() => members.id, { onDelete: "cascade" })
      .notNull(),
    fromUserId: integer("from_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    toUserId: integer("to_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    // Sans réponse 7 jours après : « expired » (reminders/roles.js)
    expiresAt: timestamp("expires_at", { precision: 3 }).notNull(),
    respondedAt: timestamp("responded_at", { precision: 3 }),
  },
  (t) => [
    uniqueIndex("role_transfers_pending_member_uq").on(t.memberId).where(sql`${t.status} = 'pending'`),
    index("role_transfers_to_user_idx").on(t.toUserId, t.status),
  ]
);

// ── Règles d'escalade des rappels du Village, par famille (UC-08) ────────────
// Réglables par les parents (A1/A2), dans des bornes fixes. Sans ligne, les
// valeurs par défaut de lib/reminderSettings.js — celles du cycle d'origine
// (J-3, la veille, +3 h, 12 h après le rendez-vous) — s'appliquent.
export const familyReminderSettings = pgTable("family_reminder_settings", {
  familyId: integer("family_id")
    .primaryKey()
    .references(() => families.id, { onDelete: "cascade" }),
  // Premier « à relayer » aux gestionnaires : 2 à 7 jours avant le rendez-vous
  relayFirstDays: integer("relay_first_days").default(3).notNull(),
  // Relance des gestionnaires : 1 (la veille) ou 2 jours avant
  followUpDaysBefore: integer("follow_up_days_before").default(1).notNull(),
  // Escalade vers les relais : 1 à 12 h après la relance sans « Prévenu »
  escalationDelayHours: integer("escalation_delay_hours").default(3).notNull(),
  // Demande de présence : "same_evening" (le soir même : 12 h après le
  // rendez-vous, comme à l'origine) | "next_morning" (le lendemain à 8 h)
  attendancePrompt: varchar("attendance_prompt", { length: 20 }).default("same_evening").notNull(),
  updatedByUserId: integer("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { precision: 3 }).defaultNow().notNull(),
});

// ── Exports des données de la famille (UC-09) ────────────────────────────────
// Un parent (A1/A2) demande, mot de passe à l'appui, une archive ZIP de tout
// ce qu'il peut lire. L'archive est préparée en arrière-plan (lib/familyExport.js)
// dans un dossier du volume des fichiers qui n'est jamais servi par /uploads,
// puis un lien à usage unique, valable 1 heure, part par courriel au
// demandeur — qui doit en plus être connecté avec le même compte pour la
// télécharger. Seule l'empreinte du jeton est conservée.
// statut : pending (en préparation) | ready (lien envoyé) | failed |
//          downloaded (téléchargée, fichier effacé) | expired (fichier effacé)
export const familyExports = pgTable(
  "family_exports",
  {
    id: serial("id").primaryKey(),
    familyId: integer("family_id")
      .references(() => families.id, { onDelete: "cascade" })
      .notNull(),
    requestedByUserId: integer("requested_by_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    // Empreinte SHA-256 du jeton du lien, posée quand l'archive est prête
    tokenHash: varchar("token_hash", { length: 64 }).unique(),
    // Nom du fichier temporaire dans uploads/exports/ (effacé après
    // téléchargement ou expiration)
    filePath: text("file_path"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    // Préparation prise en charge (serveur ou worker) : évite qu'elle soit
    // faite deux fois ; reprise si elle reste bloquée (lib/familyExport.js)
    claimedAt: timestamp("claimed_at", { precision: 3 }),
    error: text("error"),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    readyAt: timestamp("ready_at", { precision: 3 }),
    // ready_at + 1 heure
    expiresAt: timestamp("expires_at", { precision: 3 }),
    downloadedAt: timestamp("downloaded_at", { precision: 3 }),
  },
  (t) => [
    // Une seule demande en préparation par famille et par demandeur
    uniqueIndex("family_exports_pending_uq").on(t.familyId, t.requestedByUserId).where(sql`${t.status} = 'pending'`),
    index("family_exports_requester_idx").on(t.requestedByUserId, t.createdAt.desc()),
  ]
);


// ── Abonnements aux notifications push (application installable, §10) ───────
// Un appareil (navigateur) abonné par ligne : adresse du service push du
// navigateur (endpoint, propre à l'appareil) et clés de chiffrement de la
// charge utile (Web Push standard, VAPID). Supprimé quand le service push
// répond 404/410 (abonnement expiré), quand la personne retire l'appareil, ou
// à la déconnexion sur cet appareil.
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: varchar("p256dh", { length: 255 }).notNull(),
    auth: varchar("auth", { length: 255 }).notNull(),
    userAgent: varchar("user_agent", { length: 500 }),
    // Libellé lisible de l'appareil (« Chrome sur Android »)
    label: varchar("label", { length: 100 }),
    // « Masquer le détail sur l'écran verrouillé » : titre neutre
    // « Rappel SunuSanté Famille », sans nom de médicament ni de proche.
    hideDetails: boolean("hide_details").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastSuccessAt: timestamp("last_success_at"),
    // Échecs consécutifs (hors 404/410, qui suppriment l'abonnement)
    failures: integer("failures").default(0).notNull(),
    lastError: text("last_error"),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint), index("push_subscriptions_user_idx").on(t.userId)]
);

// ── Jetons d'action des notifications de prise ──────────────────────────────
// Boutons « Pris » / « Pas pris » d'une notification push : l'application
// peut être fermée et la session expirée. Chaque push de prise porte un jeton
// aléatoire (seule son empreinte SHA-256 est gardée) : usage unique, limité à
// CETTE prise et à CE compte, valable 24 h (routes/intakes.js).
export const intakeActionTokens = pgTable(
  "intake_action_tokens",
  {
    id: serial("id").primaryKey(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    intakeId: integer("intake_id")
      .references(() => medicationIntakes.id, { onDelete: "cascade" })
      .notNull(),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("intake_action_tokens_expiry_idx").on(t.expiresAt)]
);

// ── Administration de la plateforme / support (acteur A5, M13, UC-50 à 53) ───
// Cloisonnement absolu : le support agit sur les COMPTES et les MÉTADONNÉES
// techniques, jamais sur les dossiers. Aucune de ces tables ne contient — ni
// ne doit contenir — de donnée médicale.

// Comptes support : SÉPARÉS des comptes famille (jamais membres d'une
// famille), créés uniquement en ligne de commande (scripts/creerSupport.js).
// Connexion par mot de passe + code à usage unique (TOTP, RFC 6238).
export const supportUsers = pgTable("support_users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 150 }).notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  // Secret TOTP chiffré (AES-256-GCM, lib/totp.js) : jamais en clair en base.
  totpSecretEncrypted: text("totp_secret_encrypted").notNull(),
  // Dernier pas de temps (30 s) accepté : un code ne sert qu'une fois.
  totpLastStep: bigint("totp_last_step", { mode: "number" }),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at"),
});

// Sessions du support : jeton aléatoire (cookie admin_token, seule son
// empreinte est gardée), 30 minutes glissantes, sans jeton de rafraîchissement.
export const supportSessions = pgTable(
  "support_sessions",
  {
    id: serial("id").primaryKey(),
    supportUserId: integer("support_user_id")
      .references(() => supportUsers.id, { onDelete: "cascade" })
      .notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { precision: 3 }).notNull(),
    revokedAt: timestamp("revoked_at", { precision: 3 }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (t) => [index("support_sessions_user_idx").on(t.supportUserId)]
);

// Demandes adressées au support. type : recovery (UC-50) | data_deletion
// (UC-51) | report (UC-52) | other. statut : unverified (identité pas encore
// confirmée par le lien reçu) | open | in_progress | resolved | rejected.
export const supportRequests = pgTable(
  "support_requests",
  {
    id: serial("id").primaryKey(),
    // Référence lisible, ex. SUP-2026-0042
    reference: varchar("reference", { length: 30 }).unique(),
    type: varchar("type", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).default("unverified").notNull(),
    // Compte concerné (récupération, suppression) ou compte SIGNALÉ (report)
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    // Adresse du compte concerné au moment de la demande (instantané)
    accountEmail: varchar("account_email", { length: 255 }),
    // Auteur de la demande quand il est connu (compte connecté, ou compte
    // dont la récupération est demandée) : il la voit dans « Mes demandes ».
    requesterUserId: integer("requester_user_id").references(() => users.id, { onDelete: "set null" }),
    // Adresse où envoyer les réponses du support
    contactEmail: varchar("contact_email", { length: 255 }).notNull(),
    // Récupération : nouvelle adresse proposée si l'ancienne boîte est perdue
    newEmail: varchar("new_email", { length: 255 }),
    // Signalement : famille où le compte a été signalé, et motif
    familyId: integer("family_id").references(() => families.id, { onDelete: "set null" }),
    // abusive | usurped | other
    reportReason: varchar("report_reason", { length: 20 }),
    description: text("description").notNull(),
    // Suppression : la personne demande AUSSI l'effacement de sa fiche médicale
    deleteMedicalRecord: boolean("delete_medical_record").default(false).notNull(),
    // Confirmation d'identité par lien à usage unique (24 h) envoyé à
    // l'adresse du compte : la demande passe alors de unverified à open.
    verificationTokenHash: varchar("verification_token_hash", { length: 64 }).unique(),
    verificationExpiresAt: timestamp("verification_expires_at", { precision: 3 }),
    verifiedAt: timestamp("verified_at", { precision: 3 }),
    // Identité vérifiée HORS application par le support (boîte perdue)
    verifiedOfflineAt: timestamp("verified_offline_at", { precision: 3 }),
    assignedTo: integer("assigned_to").references(() => supportUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { precision: 3 }),
  },
  (t) => [
    index("support_requests_status_idx").on(t.status, t.type),
    index("support_requests_user_idx").on(t.userId),
    index("support_requests_requester_idx").on(t.requesterUserId),
  ]
);

// Échanges d'une demande (support ↔ utilisateur).
export const supportRequestMessages = pgTable(
  "support_request_messages",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id")
      .references(() => supportRequests.id, { onDelete: "cascade" })
      .notNull(),
    // "support" | "user"
    authorType: varchar("author_type", { length: 10 }).notNull(),
    supportUserId: integer("support_user_id").references(() => supportUsers.id, { onDelete: "set null" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    authorName: varchar("author_name", { length: 150 }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (t) => [index("support_request_messages_request_idx").on(t.requestId, t.createdAt)]
);

// Journal d'audit du support : INEFFAÇABLE (déclencheurs de la migration
// 0021 : ni modification ni suppression). Une ligne par action d'un compte
// support. Les cibles sont des INSTANTANÉS (identifiant + adresse) sans clé
// étrangère : la suppression d'un compte ne touche jamais au journal.
export const supportAudit = pgTable(
  "support_audit",
  {
    id: serial("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { precision: 3 }).defaultNow().notNull(),
    // NULL : action automatique (levée d'une suspension échue par le worker)
    // ou tentative de connexion avec une adresse inconnue
    supportUserId: integer("support_user_id"),
    supportEmail: varchar("support_email", { length: 255 }),
    action: varchar("action", { length: 60 }).notNull(),
    targetUserId: integer("target_user_id"),
    targetEmail: varchar("target_email", { length: 255 }),
    requestId: integer("request_id"),
    reason: text("reason"),
    // Données non médicales : statut, durée, filtres de recherche…
    details: jsonb("details"),
    ip: varchar("ip", { length: 64 }),
  },
  (t) => [index("support_audit_occurred_idx").on(t.occurredAt.desc(), t.id.desc())]
);

// Journaux techniques (UC-53) : niveau, catégorie, message, métadonnées NON
// médicales (route sans paramètres, méthode, statut, durée, id de compte,
// adresse IP tronquée, navigateur). Jamais de corps de requête ni de réponse.
// Purgés après 90 jours par le worker (lib/technicalLog.js).
export const technicalLogs = pgTable(
  "technical_logs",
  {
    id: serial("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { precision: 3 }).defaultNow().notNull(),
    // info | warn | error
    level: varchar("level", { length: 10 }).notNull(),
    // auth | http_error | email | worker | push | security | support
    category: varchar("category", { length: 20 }).notNull(),
    message: varchar("message", { length: 500 }).notNull(),
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("technical_logs_occurred_idx").on(t.occurredAt.desc(), t.id.desc()),
    index("technical_logs_category_idx").on(t.category, t.occurredAt.desc()),
  ]
);
