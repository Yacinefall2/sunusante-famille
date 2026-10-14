import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { families, familyMemberships, members, users } from "../db/schema.js";
import { ADULT_AGE, ageOn } from "./family.js";
import { documentFilesOf, removeFiles } from "./documentFiles.js";
import { archiveFicheOfLeavingAccount } from "./archive.js";
import { logActivity } from "./activityLog.js";
import { setDocumentRole } from "./documentAccess.js";
import { soleManagedFiches } from "./management.js";

// ── Suppression d'un compte : règles UNIQUES, que la suppression soit faite
// par la personne (« Mon compte », routes/account.js) ou par le support à sa
// demande écrite et identité confirmée (UC-51, routes/admin.js).

// Espaces familiaux du compte, avec ce qui bloquerait sa suppression.
export async function membershipsOf(userId) {
  const rows = await db
    .select({ membership: familyMemberships, familyName: families.name })
    .from(familyMemberships)
    .innerJoin(families, eq(families.id, familyMemberships.familyId))
    .where(eq(familyMemberships.userId, userId));
  const out = [];
  for (const { membership, familyName } of rows) {
    const others = await db
      .select({ id: familyMemberships.id })
      .from(familyMemberships)
      .where(and(eq(familyMemberships.familyId, membership.familyId), ne(familyMemberships.userId, userId)));
    out.push({ membership, familyName, otherAccounts: others.length });
  }
  return out;
}

// L'administrateur d'un espace qui compte d'autres comptes doit d'abord les
// retirer ou supprimer l'espace. Renvoie le message d'explication, ou null.
export function deletionBlocker(spaces, { bySupport = false } = {}) {
  const blocking = spaces.filter((s) => s.membership.isPrimaryAdmin && s.otherAccounts > 0);
  if (blocking.length === 0) return null;
  const names = `« ${blocking.map((s) => s.familyName).join(" », « ")} »`;
  return bySupport
    ? `Ce compte administre ${names}, qui compte d'autres comptes : la personne doit d'abord les retirer, confier l'administration ou supprimer l'espace elle-même. Suppression impossible pour l'instant.`
    : `Vous administrez ${names}, qui compte d'autres comptes : retirez-les ou supprimez l'espace avant de supprimer votre compte.`;
}

// Supprime le compte. Seul compte d'un espace qu'il administre, il supprime
// l'espace avec lui. Un adulte peut aussi faire effacer sa fiche médicale
// (deleteMyFiche) ; sinon elle reste à la famille, archivée (lib/archive.js).
// Les dossiers dont il était le seul gestionnaire sont confiés à A1 (UC-06).
// Renvoie { ok: true } ou { ok: false, error } (blocage).
export async function deleteAccount(user, { deleteMyFiche = false, bySupport = false } = {}) {
  const spaces = await membershipsOf(user.id);
  const blocker = deletionBlocker(spaces, { bySupport });
  if (blocker) return { ok: false, error: blocker };

  const familiesToDelete = spaces.filter((s) => s.membership.isPrimaryAdmin).map((s) => s.membership.familyId);
  const memberIdsToDelete = [];
  if (familiesToDelete.length > 0) {
    const rows = await db.select({ id: members.id }).from(members).where(inArray(members.familyId, familiesToDelete));
    memberIdsToDelete.push(...rows.map((r) => r.id));
  }
  if (deleteMyFiche) {
    for (const { membership } of spaces) {
      if (!membership.linkedMemberId || familiesToDelete.includes(membership.familyId)) continue;
      const [fiche] = await db.select().from(members).where(eq(members.id, membership.linkedMemberId));
      if (fiche && (ageOn(fiche.dateOfBirth) ?? ADULT_AGE) >= ADULT_AGE) memberIdsToDelete.push(fiche.id);
    }
  }

  // Fiches qui restent dans une famille : archivées (gelées, plus lisibles
  // par personne), comme lorsqu'un compte est retiré de l'espace. Le
  // journal de ces familles garde la trace du départ (le nom du compte y
  // reste, suivi de « compte supprimé »).
  //
  // Dossiers dont ce compte était le SEUL gestionnaire (UC-06) : confiés
  // automatiquement à l'Administrateur familial A1, sans lui demander —
  // la personne part, et un dossier géré ne doit jamais rester sans
  // gestionnaire. Une entrée de journal par dossier confié.
  for (const { membership } of spaces) {
    if (familiesToDelete.includes(membership.familyId)) continue;
    const actor = { id: user.id, name: user.name };
    await logActivity({ familyId: membership.familyId, actor, action: "account_deleted" });
    const [a1] = await db
      .select({ userId: familyMemberships.userId })
      .from(familyMemberships)
      .where(and(eq(familyMemberships.familyId, membership.familyId), eq(familyMemberships.isPrimaryAdmin, true)));
    if (a1 && a1.userId !== user.id) {
      for (const fiche of await soleManagedFiches(user.id, membership.familyId)) {
        await setDocumentRole(fiche.id, a1.userId, "gestionnaire");
        await logActivity({
          familyId: membership.familyId,
          actor,
          action: "management_reassigned",
          member: fiche.id,
          target: a1.userId,
          details: { reason: "account_deleted" },
        });
      }
    }
    if (memberIdsToDelete.includes(membership.linkedMemberId)) {
      await logActivity({
        familyId: membership.familyId,
        actor,
        action: "member_deleted",
        member: membership.linkedMemberId,
        details: { withAccount: true },
      });
      continue;
    }
    await archiveFicheOfLeavingAccount(membership, { actor, reason: "account_deleted" });
  }

  const files = await documentFilesOf(memberIdsToDelete);
  if (familiesToDelete.length > 0) await db.delete(families).where(inArray(families.id, familiesToDelete));
  if (memberIdsToDelete.length > 0) await db.delete(members).where(inArray(members.id, memberIdsToDelete));
  await db.delete(users).where(eq(users.id, user.id));
  await removeFiles(files);
  return { ok: true };
}
