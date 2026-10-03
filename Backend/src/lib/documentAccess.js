import { eq, and, ne, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentRoles, familyMemberships, members } from "../db/schema.js";

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
//   - Rôle de dossier explicite : selon le rôle (R2 complet, R4 lecture, R3 relais).
//   - Administrateur (A1/A2) : accès complet à toutes les fiches du foyer,
//     SAUF la fiche de l'autre administrateur (règle réciproque §10) — sauf
//     délégation explicite par un rôle de dossier (UC-26).
// Le niveau retenu est le plus fort des niveaux applicables.
export async function getFamilyAccess(req) {
  if (req._familyAccess) return req._familyAccess;

  const { membership } = req;
  const access = new Map();
  const familyMemberIds = (
    await db.select({ id: members.id }).from(members).where(eq(members.familyId, req.familyId))
  ).map((m) => m.id);

  if (membership.role === "dependent") {
    if (membership.linkedMemberId && familyMemberIds.includes(membership.linkedMemberId)) {
      access.set(membership.linkedMemberId, ACCESS.READ);
    }
    req._familyAccess = access;
    return access;
  }

  if (familyMemberIds.length > 0) {
    const myRoles = await db
      .select({ memberId: documentRoles.memberId, role: documentRoles.role })
      .from(documentRoles)
      .where(and(eq(documentRoles.userId, req.user.id), inArray(documentRoles.memberId, familyMemberIds)));
    const roleByMember = new Map(myRoles.map((r) => [r.memberId, r.role]));

    let otherAdminFiches = new Set();
    if (membership.role === "parent") {
      const otherAdmins = await db
        .select({ linkedMemberId: familyMemberships.linkedMemberId })
        .from(familyMemberships)
        .where(
          and(
            eq(familyMemberships.familyId, req.familyId),
            eq(familyMemberships.role, "parent"),
            ne(familyMemberships.userId, req.user.id),
            isNotNull(familyMemberships.linkedMemberId)
          )
        );
      otherAdminFiches = new Set(otherAdmins.map((a) => a.linkedMemberId));
    }

    for (const memberId of familyMemberIds) {
      let level = null;
      if (memberId === membership.linkedMemberId) level = ACCESS.FULL;
      level = strongest(level, ROLE_ACCESS[roleByMember.get(memberId)]);
      if (membership.role === "parent" && !otherAdminFiches.has(memberId)) level = ACCESS.FULL;
      if (level) access.set(memberId, level);
    }
  }

  req._familyAccess = access;
  return access;
}

export async function getAccess(req, memberId) {
  const access = await getFamilyAccess(req);
  return access.get(parseInt(memberId)) ?? null;
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
    const id = parseInt(req.query.memberId);
    return (await canReadMember(req, id)) ? [id] : null;
  }
  return readableMemberIds(req);
}

// Qui peut attribuer ou révoquer les rôles d'une fiche (UC-04, UC-26, §10
// « Révocation ») : son Titulaire (délégation de son propre dossier), ou un
// Administrateur ayant un accès complet à cette fiche.
export async function canManageRoles(req, memberId) {
  if (req.membership.role === "dependent") return false;
  if (req.membership.linkedMemberId === parseInt(memberId)) return true;
  return req.membership.role === "parent" && (await canWriteMember(req, memberId));
}

// Enregistre un rôle Axe 2 pour un utilisateur sur une fiche — remplace
// l'éventuel rôle déjà attribué à cette même personne sur ce même dossier
// (un seul rôle par dossier, cumulable entre dossiers différents).
export async function setDocumentRole(memberId, userId, role) {
  await db.delete(documentRoles).where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.userId, userId)));
  const [created] = await db.insert(documentRoles).values({ memberId, userId, role }).returning();
  return created;
}
