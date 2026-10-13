import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { activityLog, members, users } from "../db/schema.js";
import { APP_TIMEZONE, formatDateTime } from "./time.js";

// ── Journal d'activité (UC-10, §10 « Traçabilité », §6.3) ────────────────────
// Point unique d'écriture (logActivity) et de rédaction (ACTIONS) du journal.
// Les phrases sont rédigées ICI, côté serveur, au moment de l'affichage : la
// route GET /api/activity renvoie un texte prêt à afficher.
//
// Règle absolue : AUCUNE donnée médicale dans le journal — ni nom de
// médicament, ni motif de rendez-vous, ni titre de document, ni diagnostic,
// ni valeur publiée sur la fiche d'urgence. Seulement qui a fait quoi, sur
// quelle fiche, avec quel rôle.

export const CATEGORIES = {
  invitations: "Invitations",
  espace: "Espace familial",
  roles: "Rôles sur les dossiers",
  fiches: "Fiches",
  documents: "Documents",
  partage: "Partage médecin",
  urgence: "Fiche d'urgence",
  village: "Village",
  consentement: "Consentement",
  exports: "Exports",
};

const SPACE_ROLE = {
  parent: "co-administrateur",
  adult: "membre de la famille",
  member: "membre de la famille",
  dependent: "membre adolescent",
};
const DOC_ROLE = { gestionnaire: "gestionnaire", relais: "relais", lecteur_invite: "lecteur invité" };
const DURATION = { "2h": "valable 2 heures", "24h": "valable 24 heures", "7j": "valable 7 jours" };
// Noms des informations publiables sur la fiche d'urgence (jamais leurs valeurs).
export const EMERGENCY_FIELD_LABELS = {
  showAge: "âge",
  showBloodType: "groupe sanguin",
  showAllergies: "allergies",
  showTreatments: "traitements en cours",
  showEmergencyContact: "contact d'urgence",
  showDoctor: "médecin traitant",
};

// Manière dont l'accord oral a été obtenu (même liste que lib/consent.js,
// recopiée ici : lib/consent.js dépend déjà de ce module).
const CONSENT_HOW = {
  en_personne: "en personne",
  telephone: "par téléphone",
  intermediaire: "par l'intermédiaire d'un proche",
};

const spaceRole = (role) => SPACE_ROLE[role] ?? "membre de la famille";
const docRole = (role) => DOC_ROLE[role] ?? role;
const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;
const when = (iso) => (iso ? formatDateTime(new Date(iso)) : "date inconnue");
// « 12/11/2026 » dans le fuseau de l'application.
const day = (iso) =>
  iso ? new Intl.DateTimeFormat("fr-FR", { timeZone: APP_TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso)) : "date inconnue";
const ROLE_DURATION = { "7j": "7 jours", "30j": "30 jours", "3m": "3 mois", "1a": "1 an" };
const until = (d) => (d.expiresAt ? ` (accès jusqu'au ${day(d.expiresAt)})` : "");
// Règles de rappel du Village (UC-08), en clair.
const ATTENDANCE_PROMPT = { same_evening: "le soir même", next_morning: "le lendemain matin" };
const reminderRules = (d) =>
  `premier « à relayer » ${d.relayFirstDays} jours avant, relance ${d.followUpDaysBefore === 1 ? "la veille" : `${d.followUpDaysBefore} jours avant`}, ` +
  `escalade vers les relais ${d.escalationDelayHours} h après sans « Prévenu », présence demandée ${ATTENDANCE_PROMPT[d.attendancePrompt] ?? d.attendancePrompt}`;
const fieldsList = (d) => {
  const names = (d.fields ?? []).map((f) => EMERGENCY_FIELD_LABELS[f]).filter(Boolean);
  if (d.extraInfo) names.push("informations complémentaires");
  return names.length > 0 ? names.join(", ") : "aucune";
};
const sharedItems = (d) => {
  const items = [];
  if (d.includeEssentials) items.push("l'essentiel");
  if (d.includeTreatments) items.push("les traitements");
  if (d.includeVaccinations) items.push("les vaccinations");
  if (d.documentsCount > 0) items.push(plural(d.documentsCount, "document"));
  return items.join(", ");
};

// Catalogue des actions : catégorie et phrase. `e` porte les noms déjà mis en
// forme (actor, target, member — « Awa Diop (compte supprimé) » si le compte
// n'existe plus) et `d` les détails enregistrés.
export const ACTIONS = {
  // ── Invitations ──
  invitation_sent: {
    category: "invitations",
    text: (e, d) =>
      `${e.actor} a invité ${d.email} comme ${spaceRole(d.role)}` +
      (d.linkedMemberName ? `, avec la fiche de ${d.linkedMemberName}` : "") +
      (d.documentRole ? ` — rôle ${docRole(d.documentRole)} sur le dossier de ${d.documentMemberName}` : ""),
  },
  invitation_cancelled: {
    category: "invitations",
    text: (e, d) => `${e.actor} a annulé l'invitation envoyée à ${d.email}`,
  },
  invitation_accepted: {
    category: "invitations",
    text: (e, d) => `${e.actor} a rejoint l'espace familial comme ${spaceRole(d.role)}${e.target ? ` (invitation de ${e.target})` : ""}`,
  },
  // ── Espace familial ──
  family_created: {
    category: "espace",
    text: (e, d) => `${e.actor} a créé l'espace familial « ${d.familyName} »`,
  },
  account_removed: {
    category: "espace",
    text: (e, d) =>
      `${e.actor} a retiré ${e.target} de l'espace familial` +
      (d.rolesRemoved > 0 ? ` (${plural(d.rolesRemoved, "rôle")} de dossier retiré${d.rolesRemoved > 1 ? "s" : ""})` : ""),
  },
  account_deleted: {
    category: "espace",
    text: (e) => `${e.actor} a quitté l'espace familial en supprimant son compte`,
  },
  space_role_changed: {
    category: "espace",
    text: (e, d) => {
      if (d.to === "parent") return `${e.actor} a nommé ${e.target} co-administrateur`;
      if (d.from === "parent") return `${e.actor} a retiré à ${e.target} le rôle de co-administrateur (${spaceRole(d.to)})`;
      return `${e.actor} a changé le rôle de ${e.target} : ${spaceRole(d.from)} → ${spaceRole(d.to)}`;
    },
  },
  // Mode senior (UC-25) : simple réglage d'affichage, sans effet sur les droits.
  senior_mode_changed: {
    category: "espace",
    text: (e, d) => {
      const verb = d.on ? "activé" : "désactivé";
      return e.target ? `${e.actor} a ${verb} le mode senior pour ${e.target}` : `${e.actor} a ${verb} le mode senior`;
    },
  },
  account_linked: {
    category: "espace",
    text: (e, d) => {
      if (d.via === "claim") return `${e.actor} a désigné la fiche de ${e.member} comme la sienne`;
      if (d.via === "invitation") return `${e.actor} est désormais titulaire du dossier de ${e.member} (fiche prévue par l'invitation)`;
      return `${e.actor} a relié le compte de ${e.target} à la fiche de ${e.member}`;
    },
  },
  // ── Rôles sur les dossiers ──
  document_role_granted: {
    category: "roles",
    text: (e, d) =>
      `${e.actor} a attribué le rôle ${docRole(d.role)} à ${e.target} sur le dossier de ${e.member}` +
      until(d) +
      (d.via === "invitation" ? " (invitation acceptée)" : ""),
  },
  document_role_changed: {
    category: "roles",
    text: (e, d) => `${e.actor} a changé le rôle de ${e.target} sur le dossier de ${e.member} : ${docRole(d.from)} → ${docRole(d.to)}` + until(d),
  },
  // ── Lecteur invité : accès à durée limitée (R4) ──
  document_role_extended: {
    category: "roles",
    text: (e, d) =>
      `${e.actor} a prolongé de ${ROLE_DURATION[d.duration] ?? d.duration} l'accès de lecteur invité de ${e.target} au dossier de ${e.member}` +
      until(d),
  },
  document_role_expired: {
    category: "roles",
    text: (e) => `Accès de lecteur invité expiré : ${e.target} ne consulte plus le dossier de ${e.member}`,
  },
  // ── Transfert de gestion d'un dossier (UC-39) ──
  role_transfer_proposed: {
    category: "roles",
    text: (e) => `${e.actor} a proposé à ${e.target} de reprendre la gestion du dossier de ${e.member}`,
  },
  role_transfer_accepted: {
    category: "roles",
    text: (e, d) =>
      `${e.actor} a accepté de reprendre la gestion du dossier de ${e.member}, proposée par ${e.target}` +
      (d.proposerWasManager ? ` — ${e.target} n'en est plus gestionnaire` : ""),
  },
  role_transfer_declined: {
    category: "roles",
    text: (e) => `${e.actor} a refusé de reprendre la gestion du dossier de ${e.member}, proposée par ${e.target}`,
  },
  role_transfer_cancelled: {
    category: "roles",
    text: (e) => `${e.actor} a annulé sa proposition de transfert de la gestion du dossier de ${e.member} à ${e.target}`,
  },
  role_transfer_expired: {
    category: "roles",
    text: (e, d) =>
      `La proposition de transfert de la gestion du dossier de ${e.member} à ${e.target} a expiré sans réponse` +
      (d.proposerName ? ` (proposée par ${d.proposerName})` : ""),
  },
  // ── Réaffectation de la gestion au départ d'un compte (UC-06) ──
  management_reassigned: {
    category: "roles",
    text: (e, d) =>
      d.reason === "account_deleted"
        ? `La gestion du dossier de ${e.member} a été confiée à ${e.target} (administrateur familial) : ${e.actor}, qui en était le seul gestionnaire, a supprimé son compte`
        : `${e.actor} a confié la gestion du dossier de ${e.member} à ${e.target} lors du retrait de ${d.removedName ?? "un compte"}`,
  },
  document_role_revoked: {
    category: "roles",
    text: (e, d) => `${e.actor} a révoqué le rôle ${docRole(d.role)} de ${e.target} sur le dossier de ${e.member}`,
  },
  document_roles_auto_revoked: {
    category: "roles",
    text: (e, d) =>
      `Rôles retirés sur le dossier de ${e.member}, désormais tenu par son titulaire : ` +
      (d.removed ?? []).map((r) => `${r.name} (${docRole(r.role)})`).join(", "),
  },
  // ── Fiches ──
  member_created: {
    category: "fiches",
    text: (e, d) => (d.self ? `${e.actor} a créé sa fiche` : `${e.actor} a créé la fiche de ${e.member} et en est gestionnaire`),
  },
  member_archived: {
    category: "fiches",
    text: (e, d) =>
      `La fiche de ${e.member} a été archivée : ${e.target} a quitté la famille` +
      (d.reason === "removed" ? ` (retiré${e.actor ? ` par ${e.actor}` : ""})` : "") +
      (d.rolesRemoved > 0 ? ` ; ${plural(d.rolesRemoved, "rôle")} de dossier retiré${d.rolesRemoved > 1 ? "s" : ""}` : ""),
  },
  member_restored: {
    category: "fiches",
    text: (e) => `La fiche de ${e.member} a été rendue à ${e.actor}, de retour dans la famille`,
  },
  member_deleted: {
    category: "fiches",
    text: (e, d) => {
      if (d.withAccount) return `${e.actor} a supprimé sa fiche en supprimant son compte`;
      if (d.archived) return `${e.actor} a supprimé définitivement la fiche archivée de ${e.member}`;
      return `${e.actor} a supprimé la fiche de ${e.member}`;
    },
  },
  member_birthdate_changed: {
    category: "fiches",
    text: (e) => `${e.actor} a modifié la date de naissance de la fiche de ${e.member}`,
  },
  // ── Documents (jamais le titre) ──
  document_confidential_on: {
    category: "documents",
    text: (e, d) =>
      d.atUpload
        ? `${e.actor} a ajouté un document confidentiel au dossier de ${e.member}`
        : `${e.actor} a rendu confidentiel un document du dossier de ${e.member}`,
  },
  document_confidential_off: {
    category: "documents",
    text: (e) => `${e.actor} a levé la confidentialité d'un document du dossier de ${e.member}`,
  },
  // ── Partage médecin ──
  doctor_share_sent: {
    category: "partage",
    text: (e, d) =>
      `${e.actor} a envoyé un lien médecin pour le dossier de ${e.member} à ${d.doctorEmail} (${DURATION[d.duration] ?? d.duration})` +
      ` — éléments partagés : ${sharedItems(d)}`,
  },
  doctor_share_opened: {
    category: "partage",
    text: (e, d) => `Le lien médecin du dossier de ${e.member}${d.doctorEmail ? ` envoyé à ${d.doctorEmail}` : ""} a été ouvert`,
  },
  doctor_share_refused: {
    category: "partage",
    text: (e, d) =>
      `Ouverture refusée du lien médecin du dossier de ${e.member}${d.doctorEmail ? ` envoyé à ${d.doctorEmail}` : ""} : tentative depuis un autre appareil`,
  },
  doctor_share_revoked: {
    category: "partage",
    text: (e, d) => `${e.actor} a révoqué le lien médecin du dossier de ${e.member}${d.doctorEmail ? ` envoyé à ${d.doctorEmail}` : ""}`,
  },
  // ── Fiche d'urgence (noms des champs, jamais leurs valeurs) ──
  emergency_activated: {
    category: "urgence",
    text: (e, d) => `${e.actor} a activé la fiche d'urgence de ${e.member} — informations publiées : ${fieldsList(d)}`,
  },
  emergency_deactivated: {
    category: "urgence",
    text: (e) => `${e.actor} a désactivé la fiche d'urgence de ${e.member}`,
  },
  emergency_updated: {
    category: "urgence",
    text: (e, d) => `${e.actor} a modifié la fiche d'urgence de ${e.member} — informations publiées : ${fieldsList(d)}`,
  },
  emergency_qr_regenerated: {
    category: "urgence",
    text: (e) => `${e.actor} a régénéré le QR code de la fiche d'urgence de ${e.member} : l'ancienne carte ne fonctionne plus`,
  },
  emergency_viewed: {
    category: "urgence",
    text: (e) => `La fiche d'urgence de ${e.member} a été consultée (QR code ou lien)`,
  },
  // ── Village (jamais le motif du rendez-vous) ──
  relay_notified: {
    category: "village",
    text: (e, d) => `${e.actor} a prévenu ${e.member} de son rendez-vous du ${when(d.appointmentDate)}`,
  },
  relay_unreachable: {
    category: "village",
    text: (e, d) => `${e.actor} n'a pas pu joindre ${e.member} pour son rendez-vous du ${when(d.appointmentDate)}`,
  },
  reminder_settings_updated: {
    category: "village",
    text: (e, d) => `${e.actor} a modifié les règles de rappel du Village : ${reminderRules(d)}`,
  },
  reminder_settings_reset: {
    category: "village",
    text: (e, d) => `${e.actor} a rétabli les règles de rappel du Village par défaut : ${reminderRules(d)}`,
  },
  relay_attendance: {
    category: "village",
    text: (e, d) =>
      `${e.actor} a indiqué la présence de ${e.member} au rendez-vous du ${when(d.appointmentDate)} : ${d.attendance === "attended" ? "venu(e)" : "pas venu(e)"}`,
  },
  // ── Consentement oral du proche (UC-29, lib/consent.js) ──
  consent_attestation: {
    category: "consentement",
    text: (e, d) => `${e.actor} a attesté l'accord oral de ${e.member}${consentHow(d)}`,
  },
  consent_withdrawn: {
    category: "consentement",
    text: (e, d) =>
      `${e.actor} a enregistré le retrait de l'accord de ${e.member} : sa fiche est archivée` +
      (d.rolesRemoved > 0 ? ` (${plural(d.rolesRemoved, "rôle")} de dossier retiré${d.rolesRemoved > 1 ? "s" : ""})` : ""),
  },
  consent_renewed: {
    category: "consentement",
    text: (e, d) => `${e.actor} a réactivé la fiche de ${e.member}, qui a redonné son accord oral${consentHow(d)}, et en est gestionnaire`,
  },
  // ── Exports (UC-27 dossier en PDF, UC-09 archive de la famille) ──
  member_exported_pdf: {
    category: "exports",
    text: (e) => `${e.actor} a exporté en PDF le dossier de ${e.member}`,
  },
  family_export_requested: {
    category: "exports",
    text: (e) => `${e.actor} a demandé l'export des données de la famille (archive ZIP)`,
  },
  family_export_sent: {
    category: "exports",
    text: (e, d) =>
      `Archive des données de la famille prête : lien de téléchargement envoyé par courriel à ${e.actor}` +
      (d.fichesCount != null ? ` (${plural(d.fichesCount, "dossier")}, ${plural(d.filesCount ?? 0, "fichier")} de documents)` : ""),
  },
  family_export_downloaded: {
    category: "exports",
    text: (e) => `${e.actor} a téléchargé l'archive des données de la famille`,
  },
  family_export_failed: {
    category: "exports",
    text: (e) => `L'archive des données de la famille demandée par ${e.actor} n'a pas pu être préparée`,
  },
};

// « (en personne, accord du 12/10/2026) »
function consentHow(d) {
  const how = CONSENT_HOW[d.method] ?? null;
  const parts = [
    d.method === "intermediaire" && d.intermediaryName ? `${how} (${d.intermediaryName})` : how,
    d.obtainedOn ? `accord du ${d.obtainedOn.split("-").reverse().join("/")}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

// Événements de fiche toujours visibles des parents, même sans accès à la
// fiche (archivée, supprimée, ou fiche de l'autre parent) : ils ne disent
// rien du dossier lui-même.
export const ALWAYS_VISIBLE_TO_PARENTS = ["member_archived", "member_restored", "member_deleted", "consent_withdrawn", "consent_renewed"];

export const actionsOfCategory = (category) =>
  Object.entries(ACTIONS)
    .filter(([, a]) => a.category === category)
    .map(([key]) => key);

export const fullName = (m) => (m ? `${m.firstName} ${m.lastName}`.trim() : null);

async function resolveMember(member) {
  if (!member) return null;
  if (typeof member === "object" && "firstName" in member) return member;
  const id = typeof member === "object" ? member.id : member;
  const [row] = await db
    .select({ id: members.id, firstName: members.firstName, lastName: members.lastName })
    .from(members)
    .where(eq(members.id, id));
  return row ?? null;
}

async function resolveUser(user) {
  if (!user) return null;
  if (typeof user === "object" && "name" in user) return user;
  const id = typeof user === "object" ? user.id : user;
  const [row] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, id));
  return row ?? null;
}

// Enregistre une entrée. `actor` et `target` : comptes { id, name } (ou un
// identifiant) ; `member` : fiche { id, firstName, lastName } (ou un
// identifiant) ; `details` : données NON médicales. Ne fait JAMAIS échouer
// l'action principale : une erreur est seulement consignée dans les logs.
export async function logActivity({ familyId, actor = null, action, member = null, target = null, details = null, at = new Date() }) {
  try {
    if (!ACTIONS[action]) throw new Error(`Action de journal inconnue : ${action}`);
    const [fiche, actorUser, targetUser] = await Promise.all([resolveMember(member), resolveUser(actor), resolveUser(target)]);
    await db.insert(activityLog).values({
      familyId,
      occurredAt: at,
      actorUserId: actorUser?.id ?? null,
      actorName: actorUser?.name ?? null,
      action,
      memberId: fiche?.id ?? null,
      memberName: fullName(fiche),
      targetUserId: targetUser?.id ?? null,
      targetName: targetUser?.name ?? null,
      details,
    });
  } catch (error) {
    console.error("Journal d'activité : entrée non enregistrée", error);
  }
}

// Une entrée de ce type existe-t-elle déjà pour cet objet depuis `since` ?
// (ex. une seule « ouverture refusée » par lien et par heure.)
export async function recentlyLogged(familyId, action, key, value, since) {
  const [row] = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.familyId, familyId),
        eq(activityLog.action, action),
        gt(activityLog.occurredAt, since),
        sql`${activityLog.details}->>${key} = ${String(value)}`
      )
    )
    .limit(1);
  return Boolean(row);
}

// Nom affiché d'un compte : instantané conservé, suivi de « (compte
// supprimé) » si le compte n'existe plus.
function displayName(userId, name, existing) {
  if (!name) return null;
  return userId && existing.has(userId) ? name : `${name} (compte supprimé)`;
}

// Met en forme des lignes activity_log pour l'interface.
export async function presentEntries(rows) {
  const ids = [...new Set(rows.flatMap((r) => [r.actorUserId, r.targetUserId]).filter(Boolean))];
  const existing = new Set(
    ids.length > 0 ? (await db.select({ id: users.id }).from(users).where(inArray(users.id, ids))).map((u) => u.id) : []
  );
  return rows.map((r) => {
    const def = ACTIONS[r.action];
    const e = {
      actor: displayName(r.actorUserId, r.actorName, existing) ?? "Quelqu'un",
      target: displayName(r.targetUserId, r.targetName, existing),
      member: r.memberName ?? "une fiche supprimée",
    };
    let text = r.action;
    if (def) {
      try {
        text = def.text(e, r.details ?? {});
      } catch {
        text = r.action;
      }
    }
    return {
      id: r.id,
      occurredAt: r.occurredAt,
      action: r.action,
      category: def?.category ?? null,
      text,
      memberId: r.memberId,
      memberName: r.memberName,
    };
  });
}
