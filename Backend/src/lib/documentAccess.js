import { eq, and, ne, inArray, isNotNull, isNull, or, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentRoles, familyMemberships, members, users } from "../db/schema.js";
import { effectiveRole } from "./family.js";
import { parseId } from "./validation.js";

// ── Contrôle d'accès dossier par dossier ─────────────────────────────────────
// Point unique de décision : chaque route qui lit ou écrit des données
// médicales passe par getFamilyAccess / getAccess, jamais par un test de rôle
// d'espace isolé.
//
// Niveaux d'accès à une fiche :
//   FULL  — lecture et écriture (Titulaire, Gestionnaire, Administrateur)
//   READ  — lecture seule (Lecteur invité, Adolescent sur sa propre fiche)
//   RELAY — date, heure et lieu des rendez-vous uniquement (Relais, §4.4)
//   null  — aucun accès
export const ACCESS = { FULL: "full", READ: "read", RELAY: "relay" };
const RANK = { [ACCESS.RELAY]: 1, [ACCESS.READ]: 2, [ACCESS.FULL]: 3 };

// Rôles de dossier attribuables (Axe 2). Le Titulaire (R1) n'en fait pas
// partie : c'est le compte relié à la fiche (family_memberships.linkedMemberId).
export const DOCUMENT_ROLES = ["gestionnaire", "relais", "lecteur_invite"];
const ROLE_ACCESS = {
  gestionnaire: ACCESS.FULL,
  lecteur_invite: ACCESS.READ,
  relais: ACCESS.RELAY,
};

// Durées d'accès d'un Lecteur invité (R4 : « consultation seule, durée
// limitée ») — obligatoires à l'attribution, à l'invitation et à la
// prolongation.
export const ROLE_DURATIONS = {
  "7j": { days: 7, label: "7 jours" },
  "30j": { days: 30, label: "30 jours" },
  "3m": { months: 3, label: "3 mois" },
  "1a": { months: 12, label: "1 an" },
};
export const DURATION_REQUIRED_ERROR = "Choisissez la durée d'accès du lecteur invité : 7 jours, 30 jours, 3 mois ou 1 an";
export const isRoleDuration = (value) => Object.hasOwn(ROLE_DURATIONS, value ?? "");

// Échéance d'un accès de lecteur invité : `from` + la durée choisie (mois
// calendaires pour « 3 mois » et « 1 an »).
export function expiryFor(duration, from = new Date()) {
  const d = ROLE_DURATIONS[duration];
  if (!d) return null;
  const end = new Date(from.getTime());
  if (d.days) end.setTime(end.getTime() + d.days * 24 * 60 * 60 * 1000);
  if (d.months) end.setUTCMonth(end.getUTCMonth() + d.months);
  return end;
}

// Rôle de dossier encore en vigueur à `now` (sans échéance, ou échéance future).
export const activeRole = (now = new Date()) => or(isNull(documentRoles.expiresAt), gt(documentRoles.expiresAt, now));

function strongest(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

// Calcule le niveau d'accès de req.user à chaque fiche de req.familyId
// (Map memberId → niveau ; les fiches sans accès sont absentes). Suppose que
// requireFamilyMembership a déjà posé req.familyId et req.membership. Le
// résultat est mis en cache sur la requête.
//
// Règles (spécification §2, §9 et §10) :
//   - Adolescent / dépendant : lecture seule de sa propre fiche, rien d'autre.
//   - Sa propre fiche (fiche reliée au compte) : accès complet (R1).
//   - Rôle de dossier explicite : selon le rôle (R2 complet, R4 lecture, R3
//     relais). Un rôle dont l'échéance est passée (lecteur invité) ne compte
//     plus, même avant que le worker ne le supprime.
//   - Administrateur (A1/A2) : accès complet à toutes les fiches du foyer,
//     SAUF la fiche de l'autre administrateur (règle réciproque §10) — sauf
//     délégation explicite par un rôle de dossier (UC-26).
// Le niveau retenu est le plus fort des niveaux applicables.
//
// Une fiche ARCHIVÉE (members.archivedAt, voir lib/archive.js) n'est
// accessible à personne, quel que soit le rôle — parents compris.
export async function getFamilyAccess(req) {
  if (req._familyAccess) return req._familyAccess;
  req._familyAccess = await computeFamilyAccess({
    userId: req.user.id,
    familyId: req.familyId,
    role: req.membership.role,
    linkedMemberId: req.membership.linkedMemberId,
  });
  return req._familyAccess;
}

// Même calcul, sans requête HTTP (moteur de rappels, vérifications à
// l'acceptation d'une invitation…). `role` est le rôle EFFECTIF du compte.
export async function computeFamilyAccess({ userId, familyId, role, linkedMemberId }) {
  const access = new Map();
  const familyMemberIds = (
    await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.familyId, familyId), isNull(members.archivedAt)))
  ).map((m) => m.id);

  if (role === "dependent") {
    if (linkedMemberId && familyMemberIds.includes(linkedMemberId)) access.set(linkedMemberId, ACCESS.READ);
    return access;
  }

  if (familyMemberIds.length > 0) {
    const myRoles = await db
      .select({ memberId: documentRoles.memberId, role: documentRoles.role })
      .from(documentRoles)
      .where(and(eq(documentRoles.userId, userId), inArray(documentRoles.memberId, familyMemberIds), activeRole()));
    const roleByMember = new Map(myRoles.map((r) => [r.memberId, r.role]));

    let otherAdminFiches = new Set();
    if (role === "parent") {
      const otherAdmins = await db
        .select({ linkedMemberId: familyMemberships.linkedMemberId })
        .from(familyMemberships)
        .where(
          and(
            eq(familyMemberships.familyId, familyId),
            eq(familyMemberships.role, "parent"),
            ne(familyMemberships.userId, userId),
            isNotNull(familyMemberships.linkedMemberId)
          )
        );
      otherAdminFiches = new Set(otherAdmins.map((a) => a.linkedMemberId));
    }

    for (const memberId of familyMemberIds) {
      let level = null;
      if (memberId === linkedMemberId) level = ACCESS.FULL;
      level = strongest(level, ROLE_ACCESS[roleByMember.get(memberId)]);
      if (role === "parent" && !otherAdminFiches.has(memberId)) level = ACCESS.FULL;
      if (level) access.set(memberId, level);
    }
  }
  return access;
}

// Appartenance d'un compte à une famille, avec son rôle EFFECTIF (selon
// l'âge de sa fiche, comme requireFamilyMembership). null s'il n'en est pas.
export async function membershipOf(userId, familyId) {
  const [membership] = await db
    .select()
    .from(familyMemberships)
    .where(and(eq(familyMemberships.userId, userId), eq(familyMemberships.familyId, familyId)));
  if (!membership) return null;
  membership.storedRole = membership.role;
  if (membership.role !== "parent" && membership.linkedMemberId) {
    const [fiche] = await db
      .select({ dateOfBirth: members.dateOfBirth })
      .from(members)
      .where(eq(members.id, membership.linkedMemberId));
    membership.role = effectiveRole(membership.role, fiche?.dateOfBirth);
  }
  return membership;
}

// Niveau d'accès d'un compte quelconque à une fiche (null : aucun, y compris
// s'il n'appartient plus à la famille).
export async function userAccessTo(userId, memberId) {
  const [fiche] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, memberId));
  if (!fiche) return null;
  const membership = await membershipOf(userId, fiche.familyId);
  if (!membership) return null;
  const access = await computeFamilyAccess({
    userId,
    familyId: fiche.familyId,
    role: membership.role,
    linkedMemberId: membership.linkedMemberId,
  });
  return access.get(memberId) ?? null;
}

// Ne garde, parmi `users` ({ id, … }), que ceux dont l'accès réel à la fiche
// satisfait `allowed` (par défaut : lecture du dossier). Sert à filtrer les
// destinataires des rappels : un compte qui a perdu l'accès ne reçoit rien.
export async function withAccess(users, memberId, allowed = (level) => canRead(level)) {
  const kept = [];
  for (const user of users) {
    if (allowed(await userAccessTo(user.id, memberId))) kept.push(user);
  }
  return kept;
}

export async function getAccess(req, memberId) {
  const access = await getFamilyAccess(req);
  const id = parseId(memberId);
  return id ? access.get(id) ?? null : null;
}

export const canRead = (level) => level === ACCESS.FULL || level === ACCESS.READ;
export const canWrite = (level) => level === ACCESS.FULL;

export async function canReadMember(req, memberId) {
  return canRead(await getAccess(req, memberId));
}

export async function canWriteMember(req, memberId) {
  return canWrite(await getAccess(req, memberId));
}

// Fiches dont req.user peut lire le dossier médical, dans req.familyId.
export async function readableMemberIds(req) {
  const access = await getFamilyAccess(req);
  return [...access].filter(([, level]) => canRead(level)).map(([id]) => id);
}

// Périmètre d'une route de liste : ?memberId= → cette fiche si elle est
// lisible (sinon null → 403), sans paramètre → toutes les fiches lisibles.
export async function readableScope(req) {
  if (req.query.memberId) {
    const id = parseId(req.query.memberId);
    return id && (await canReadMember(req, id)) ? [id] : null;
  }
  return readableMemberIds(req);
}

// Qui peut attribuer ou révoquer les rôles d'une fiche (UC-04, UC-26, §10
// « Révocation ») : son Titulaire (délégation de son propre dossier), ou un
// Administrateur ayant un accès complet à cette fiche.
export async function canManageRoles(req, memberId) {
  if (req.membership.role === "dependent") return false;
  if (req.membership.linkedMemberId === parseId(memberId)) return true;
  return req.membership.role === "parent" && (await canWriteMember(req, memberId));
}

// ── Documents : confidentialité (UC-16, §10) et suppression (UC-15) ─────────

// Titulaire de la fiche = compte qui y est relié.
export function isHolder(req, memberId) {
  return req.membership.linkedMemberId === parseId(memberId);
}

// Un document confidentiel n'est visible que du titulaire du dossier et de
// l'Administrateur familial A1 (qui doit par ailleurs pouvoir lire le dossier).
export function canSeeDocument(req, doc) {
  return !doc.isConfidential || isHolder(req, doc.memberId) || req.membership.isPrimaryAdmin;
}

// Seul le titulaire marque un document confidentiel — jamais un adolescent (§9.6).
export function canSetConfidential(req, memberId) {
  return isHolder(req, memberId) && req.membership.role !== "dependent";
}

// Suppression : accès complet au dossier ET (auteur du document OU titulaire
// du dossier). Documents antérieurs sans auteur connu : le titulaire, ou un
// Administrateur si la fiche n'est reliée à aucun compte.
async function canDeleteDocument(req, doc, accountFiches) {
  if (!(await canWriteMember(req, doc.memberId))) return false;
  if (doc.uploadedByUserId === req.user.id || isHolder(req, doc.memberId)) return true;
  return doc.uploadedByUserId === null && req.membership.role === "parent" && !accountFiches.has(doc.memberId);
}

async function accountFichesOf(familyId) {
  const rows = await db
    .select({ linkedMemberId: familyMemberships.linkedMemberId })
    .from(familyMemberships)
    .where(and(eq(familyMemberships.familyId, familyId), isNotNull(familyMemberships.linkedMemberId)));
  return new Set(rows.map((r) => r.linkedMemberId));
}

export async function canDeleteDocumentFor(req, doc) {
  return canSeeDocument(req, doc) && canDeleteDocument(req, doc, await accountFichesOf(req.familyId));
}

// Filtre les documents visibles et ajoute pour l'interface : canDelete,
// canSetConfidential et uploadedByName.
export async function presentDocuments(req, docs) {
  const visible = docs.filter((d) => canSeeDocument(req, d));
  if (visible.length === 0) return [];
  const accountFiches = await accountFichesOf(req.familyId);
  const authorIds = [...new Set(visible.map((d) => d.uploadedByUserId).filter(Boolean))];
  const authors = new Map(
    authorIds.length > 0
      ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, authorIds))).map((u) => [u.id, u.name])
      : []
  );
  return Promise.all(
    visible.map(async (d) => ({
      ...d,
      uploadedByName: authors.get(d.uploadedByUserId) ?? null,
      canDelete: await canDeleteDocument(req, d, accountFiches),
      canSetConfidential: canSetConfidential(req, d.memberId),
    }))
  );
}

// Enregistre un rôle Axe 2 pour un utilisateur sur une fiche — remplace
// l'éventuel rôle déjà attribué à cette même personne sur ce même dossier
// (un seul rôle par dossier, cumulable entre dossiers différents).
// `expiresAt` : échéance d'un Lecteur invité (ignorée pour les autres rôles).
// `executor` : transaction en cours, le cas échéant.
export async function setDocumentRole(memberId, userId, role, { expiresAt = null, executor = db } = {}) {
  await executor.delete(documentRoles).where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.userId, userId)));
  const [created] = await executor
    .insert(documentRoles)
    .values({ memberId, userId, role, expiresAt: role === "lecteur_invite" ? expiresAt : null })
    .returning();
  return created;
}
