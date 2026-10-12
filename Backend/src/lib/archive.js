import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  doctorShares,
  documentRoles,
  emergencyCards,
  familyMemberships,
  members,
  notifications,
  pendingInvitations,
  roleTransfers,
  users,
} from "../db/schema.js";
import { effectiveRole, statusForLinkedFiche } from "./family.js";
import { userAccessTo } from "./documentAccess.js";
import { logActivity } from "./activityLog.js";

// ── Fiches reliées à un compte : liaison, départ, archivage ──────────────────
// Décision métier « Fiche archivée » : quand un compte ADULTE quitte la
// famille (retiré de l'espace ou compte supprimé), sa fiche est GELÉE —
// personne n'y a plus accès (pas même les parents), elle ne peut être reliée
// à aucun autre compte, seul l'Administrateur familial A1 peut la supprimer,
// et elle est rendue automatiquement à son ancien titulaire s'il rejoint de
// nouveau la famille. La fiche d'un ADOLESCENT n'est jamais archivée : elle
// redevient une fiche gérée par les parents, comme celle d'un enfant.

// Supprime les notifications d'une fiche pour les comptes qui n'y ont plus
// aucun accès (rôle révoqué, fiche reliée à son titulaire, archivée…).
// `userId` restreint le ménage à un seul compte.
export async function purgeNotificationsWithoutAccess(memberId, userId = null) {
  const rows = await db
    .selectDistinct({ userId: notifications.userId })
    .from(notifications)
    .where(and(eq(notifications.memberId, memberId), userId ? eq(notifications.userId, userId) : undefined));
  for (const row of rows) {
    if ((await userAccessTo(row.userId, memberId)) === null) {
      await db.delete(notifications).where(and(eq(notifications.memberId, memberId), eq(notifications.userId, row.userId)));
    }
  }
}

// À appeler chaque fois qu'une fiche devient celle d'un compte (acceptation
// d'invitation, « Ma fiche », liaison par un parent). Les rôles de dossier
// posés AVANT la liaison (le créateur de la fiche en est gestionnaire,
// members.js) ne doivent pas survivre : c'est désormais le titulaire qui
// décide qui accède à son dossier (§10). Exception : la fiche d'un
// adolescent garde ses gestionnaires (les parents gèrent l'adolescent).
// Met aussi à jour le statut (Axe 3) et, pour un parent, le lien « Parent ».
// Renvoie les rôles retirés à d'autres comptes que le nouveau titulaire
// ([{ userId, name, role }]) — pour l'entrée récapitulative du journal
// (logRolesAutoRevoked).
export async function afterFicheLinked({ memberId, userId, role }) {
  const [fiche] = await db.select().from(members).where(eq(members.id, memberId));
  if (!fiche) return [];
  const teen = effectiveRole(role, fiche.dateOfBirth) === "dependent";
  const removed = await db
    .delete(documentRoles)
    .where(
      and(
        eq(documentRoles.memberId, memberId),
        teen ? or(ne(documentRoles.role, "gestionnaire"), eq(documentRoles.userId, userId)) : undefined
      )
    )
    .returning({ userId: documentRoles.userId, role: documentRoles.role });
  await db
    .update(members)
    .set({
      status: statusForLinkedFiche(role, fiche.dateOfBirth, fiche.status),
      ...(role === "parent" ? { kinship: "parent", kinshipRelatedMemberId: null } : {}),
    })
    .where(eq(members.id, memberId));
  await purgeNotificationsWithoutAccess(memberId);
  const others = removed.filter((r) => r.userId !== userId);
  if (others.length === 0) return [];
  const names = new Map(
    (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, others.map((r) => r.userId)))).map((u) => [u.id, u.name])
  );
  return others.map((r) => ({ userId: r.userId, name: names.get(r.userId) ?? "un compte", role: r.role }));
}

// Journal : une seule entrée pour tous les rôles retirés à la liaison d'une fiche.
export async function logRolesAutoRevoked({ familyId, actor, member, removed }) {
  if (!removed?.length) return;
  await logActivity({
    familyId,
    actor,
    action: "document_roles_auto_revoked",
    member,
    details: { removed: removed.map((r) => ({ name: r.name, role: r.role })) },
  });
}

// Une fiche n'a plus de titulaire (compte adolescent retiré, ou relié à une
// autre fiche) : elle redevient une fiche tenue par les parents.
export async function afterFicheUnlinked(memberId, executor = db) {
  await executor.update(members).set({ status: "mineur_gere" }).where(eq(members.id, memberId));
}

// Gel d'une fiche qui vient d'être archivée : rôles de dossier supprimés,
// notifications effacées, invitations qui la visent annulées, liens médecin
// révoqués et fiche d'urgence désactivée — plus rien ne doit sortir d'un
// dossier gelé (rappels et Village ignorent déjà les fiches archivées).
// Les propositions de transfert de sa gestion en attente sont annulées.
// Renvoie le nombre de rôles de dossier retirés. `executor` : transaction
// en cours, le cas échéant.
async function freezeFiche(memberId, now, executor = db) {
  const rolesRemoved = await executor.delete(documentRoles).where(eq(documentRoles.memberId, memberId)).returning({ id: documentRoles.id });
  await executor.delete(notifications).where(eq(notifications.memberId, memberId));
  await executor
    .update(roleTransfers)
    .set({ status: "cancelled", respondedAt: now })
    .where(and(eq(roleTransfers.memberId, memberId), eq(roleTransfers.status, "pending")));
  await executor
    .delete(pendingInvitations)
    .where(
      and(
        isNull(pendingInvitations.acceptedAt),
        or(eq(pendingInvitations.linkedMemberId, memberId), eq(pendingInvitations.documentMemberId, memberId))
      )
    );
  await executor
    .update(doctorShares)
    .set({ revokedAt: now })
    .where(and(eq(doctorShares.memberId, memberId), isNull(doctorShares.revokedAt)));
  await executor.update(emergencyCards).set({ active: false }).where(eq(emergencyCards.memberId, memberId));
  return rolesRemoved.length;
}

// Un compte quitte la famille : `membership` est sa ligne family_memberships
// (rôle ENREGISTRÉ dans `role`, ou dans `storedRole` si la ligne vient de
// requireFamilyMembership). À appeler AVANT de supprimer cette ligne ou le
// compte. Renvoie { memberId, archived } ou null si le compte n'avait pas de
// fiche. `actor` (qui a retiré le compte, ou le compte lui-même) et `reason`
// ("removed" | "account_deleted") servent au journal d'activité. `tx` :
// transaction en cours (retrait d'un compte avec réaffectation, UC-06).
//   - compte adolescent : la fiche redevient gérée par les parents ;
//   - compte adulte (ou parent) : la fiche est archivée — rôles de dossier
//     supprimés, notifications effacées, invitations qui la visent annulées,
//     liens médecin révoqués et fiche d'urgence désactivée (plus rien ne doit
//     sortir d'un dossier gelé).
export async function archiveFicheOfLeavingAccount(membership, { now = new Date(), actor = null, reason = "removed", tx = db } = {}) {
  if (!membership?.linkedMemberId) return null;
  const memberId = membership.linkedMemberId;
  const [fiche] = await tx.select().from(members).where(eq(members.id, memberId));
  if (!fiche) return null;

  // La fiche est libérée tout de suite (index unique sur linkedMemberId).
  if (membership.id) {
    await tx.update(familyMemberships).set({ linkedMemberId: null }).where(eq(familyMemberships.id, membership.id));
  }

  const storedRole = membership.storedRole ?? membership.role;
  if (effectiveRole(storedRole, fiche.dateOfBirth) === "dependent") {
    await afterFicheUnlinked(memberId, tx);
    await tx.delete(notifications).where(and(eq(notifications.memberId, memberId), eq(notifications.userId, membership.userId)));
    return { memberId, archived: false };
  }

  await tx
    .update(members)
    .set({ archivedAt: now, archivedUserId: membership.userId, archivedReason: "departure" })
    .where(eq(members.id, memberId));
  const rolesRemoved = await freezeFiche(memberId, now, tx);
  // Entrée toujours visible des parents : rien du dossier lui-même.
  await logActivity({
    familyId: fiche.familyId,
    actor,
    action: "member_archived",
    member: fiche,
    target: membership.userId,
    details: { reason, rolesRemoved },
    at: now,
  });
  return { memberId, archived: true };
}

// L'ancien titulaire rejoint la famille : sa fiche archivée la plus récente
// lui est rendue (désarchivée). La liaison au nouveau compte reste à faire
// par l'appelant (puis afterFicheLinked). Renvoie la fiche, ou null.
export async function restoreArchivedFiche(userId, familyId) {
  const [fiche] = await db
    .select()
    .from(members)
    .where(and(eq(members.familyId, familyId), eq(members.archivedUserId, userId), isNotNull(members.archivedAt)))
    .orderBy(desc(members.archivedAt))
    .limit(1);
  if (!fiche) return null;
  const [restored] = await db
    .update(members)
    .set({ archivedAt: null, archivedUserId: null, archivedReason: null })
    .where(eq(members.id, fiche.id))
    .returning();
  return restored;
}

// Le proche SANS compte a retiré son accord oral (UC-29) : sa fiche est
// archivée — gelée exactement comme celle d'un titulaire parti (aucun accès
// pour personne, rôles de dossier retirés, rappels et Village coupés, liens
// médecin révoqués, fiche d'urgence désactivée). Un parent pourra la
// réactiver par une nouvelle attestation (routes/members.js). Renvoie le
// nombre de rôles de dossier retirés ; la journalisation (consent_withdrawn)
// revient à l'appelant.
export async function archiveFicheWithoutAccount(memberId, { now = new Date(), reason = "consent_withdrawn" } = {}) {
  await db
    .update(members)
    .set({ archivedAt: now, archivedUserId: null, archivedReason: reason })
    .where(eq(members.id, memberId));
  return freezeFiche(memberId, now);
}

export const ARCHIVED_ERROR = "Cette fiche est archivée : son titulaire a quitté la famille, elle ne peut être reliée à aucun autre compte";
export const ARCHIVED_CONSENT_ERROR =
  "Cette fiche est archivée : le proche a retiré son accord. Un parent peut la réactiver si le proche redonne son accord";

// Message d'erreur selon le motif d'archivage de la fiche.
export const archivedErrorOf = (fiche) => (fiche?.archivedReason === "consent_withdrawn" ? ARCHIVED_CONSENT_ERROR : ARCHIVED_ERROR);

