import { Router } from "express";
import { eq, and, sql, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { familyMemberships, users, members, documentRoles, notifications } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { canWriteMember } from "../lib/documentAccess.js";
import { ADULT_AGE, ACCOUNT_MIN_AGE, MINOR_PARENT_ERROR, UNDER_MIN_AGE_ERROR, ageOn, effectiveRole, statusForLinkedFiche } from "../lib/family.js";
import { afterFicheLinked, afterFicheUnlinked, archivedErrorOf, archiveFicheOfLeavingAccount, logRolesAutoRevoked } from "../lib/archive.js";
import { logActivity } from "../lib/activityLog.js";
import { familyIdFromQuery } from "../lib/familyResolvers.js";
import { INVALID_ID, parseId } from "../lib/validation.js";

const router = Router();

const ALLOWED_ROLES = ["parent", "adult", "dependent"];
const MAX_PARENTS = 2;

// Liste des comptes ayant accès à la famille, avec leur rôle — visible à
// tous les membres de la famille (pas seulement les Parents).
router.get(
  "/",
  requireFamilyMembership(familyIdFromQuery),
  async (req, res) => {
    try {
      const rows = await db
        .select({
          id: familyMemberships.id,
          role: familyMemberships.role,
          isPrimaryAdmin: familyMemberships.isPrimaryAdmin,
          linkedMemberId: familyMemberships.linkedMemberId,
          createdAt: familyMemberships.createdAt,
          userId: users.id,
          name: users.name,
          email: users.email,
          dateOfBirth: members.dateOfBirth,
        })
        .from(familyMemberships)
        .innerJoin(users, eq(familyMemberships.userId, users.id))
        .leftJoin(members, eq(members.id, familyMemberships.linkedMemberId))
        .where(eq(familyMemberships.familyId, req.familyId));
      // Rôle effectif (selon l'âge de la fiche) : c'est lui qui fait foi.
      res.json(rows.map(({ dateOfBirth, ...r }) => ({ ...r, role: effectiveRole(r.role, dateOfBirth), age: ageOn(dateOfBirth) })));
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Résout la familyId à partir de l'id d'une family_membership (pour PUT/DELETE,
// qui ne reçoivent que l'id de la ligne, pas familyId directement)
async function resolveFamilyIdFromMembershipId(req) {
  const id = parseId(req.body?.id ?? req.query?.id);
  if (!id) return null;
  const [row] = await db
    .select({ familyId: familyMemberships.familyId })
    .from(familyMemberships)
    .where(eq(familyMemberships.id, id));
  return row?.familyId ?? null;
}

// Changer le rôle d'un membre — réservé aux Parents
router.put("/", requireFamilyMembership(resolveFamilyIdFromMembershipId, { roles: ["parent"] }), async (req, res) => {
  try {
    const { id, role, linkedMemberId } = req.body;
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ error: "Rôle invalide" });
    }

    const membershipId = parseId(id);
    const [existing] = await db.select().from(familyMemberships).where(eq(familyMemberships.id, membershipId));
    if (!existing) return res.status(404).json({ error: "Introuvable" });

    // Un Parent ne peut pas modifier les informations (rôle, fiche liée...)
    // d'un autre Parent — seul l'intéressé (ou lui-même) peut le faire.
    // Ne bloque pas un Parent qui modifierait sa propre ligne.
    if (existing.role === "parent" && existing.userId !== req.user.id) {
      return res.status(403).json({
        error: "Un Parent ne peut pas modifier les informations d'un autre Parent",
      });
    }

    // L'Administrateur familial (A1) garde son rôle : l'espace ne doit
    // jamais se retrouver sans A1 (seul habilité à le supprimer, UC-11).
    if (existing.isPrimaryAdmin && role !== "parent") {
      return res.status(403).json({ error: "L'administrateur familial ne peut pas quitter son rôle" });
    }

    // Promouvoir un co-administrateur est exclusif à A1 (UC-05, section 9.2).
    if (role === "parent" && existing.role !== "parent" && !req.membership.isPrimaryAdmin) {
      return res.status(403).json({
        error: "Seul l'administrateur qui a créé l'espace familial peut nommer un co-administrateur",
      });
    }

    // Limite : maximum 2 parents par famille
    if (role === "parent" && existing.role !== "parent") {
      const [parentCount] = await db
        .select({ count: sql`count(*)::int` })
        .from(familyMemberships)
        .where(and(eq(familyMemberships.familyId, req.familyId), eq(familyMemberships.role, "parent")));
      if (parentCount.count >= MAX_PARENTS) {
        return res.status(400).json({ error: `Une famille ne peut avoir que ${MAX_PARENTS} parents maximum` });
      }
    }

    // Fiche de la personne (« sa fiche », dont elle est Titulaire) — valable
    // pour tous les rôles, conservée d'un rôle à l'autre, obligatoire pour un
    // "dependent". Seul le titulaire choisit sa fiche (POST /api/members/claim) :
    // un Parent ne relie ici que le compte d'un AUTRE qui n'a pas encore de
    // fiche, ou un compte adolescent ; jamais un adulte qui a déjà la sienne
    // (ni pour la lui retirer, ni pour lui en donner une autre).
    const [currentFiche] = existing.linkedMemberId
      ? await db.select().from(members).where(eq(members.id, existing.linkedMemberId))
      : [];
    let newFiche = currentFiche ?? null;
    let newLinkedMemberId = existing.linkedMemberId;
    const hasLinkedParam = linkedMemberId !== undefined && linkedMemberId !== null && linkedMemberId !== "";
    const parsedId = hasLinkedParam ? parseId(linkedMemberId) : null;
    if (hasLinkedParam && !parsedId) return res.status(400).json({ error: INVALID_ID });
    if (parsedId && parsedId !== existing.linkedMemberId) {
      if (existing.userId === req.user.id) {
        return res.status(403).json({ error: "Utilisez « Ma fiche » pour désigner votre propre fiche" });
      }
      if (existing.linkedMemberId && effectiveRole(existing.role, currentFiche?.dateOfBirth) !== "dependent") {
        return res.status(403).json({ error: "Ce compte a déjà sa fiche : seul son titulaire peut en changer" });
      }
      const [member] = await db.select().from(members).where(eq(members.id, parsedId));
      if (!member || member.familyId !== req.familyId) {
        return res.status(400).json({ error: "Fiche membre introuvable dans cette famille" });
      }
      if (member.archivedAt) return res.status(409).json({ error: archivedErrorOf(member) });
      const [alreadyLinked] = await db
        .select({ id: familyMemberships.id })
        .from(familyMemberships)
        .where(eq(familyMemberships.linkedMemberId, parsedId));
      if (alreadyLinked) {
        return res.status(409).json({ error: "Cette fiche est déjà celle d'un autre compte" });
      }
      if (!(await canWriteMember(req, parsedId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits sur cette fiche" });
      }
      // Même règle d'âge que les invitations : pas de compte avant 15 ans.
      const age = ageOn(member.dateOfBirth);
      if (age !== null && age < ACCOUNT_MIN_AGE) return res.status(400).json({ error: UNDER_MIN_AGE_ERROR });
      newLinkedMemberId = parsedId;
      newFiche = member;
    }
    if (role === "dependent" && !newLinkedMemberId) {
      return res.status(400).json({ error: "Choisissez la fiche membre correspondant à cette personne" });
    }
    // Un mineur n'est jamais administrateur du foyer.
    if (role === "parent" && newFiche && ageOn(newFiche.dateOfBirth) !== null && ageOn(newFiche.dateOfBirth) < ADULT_AGE) {
      return res.status(400).json({ error: MINOR_PARENT_ERROR });
    }

    const [updated] = await db
      .update(familyMemberships)
      .set({ role, linkedMemberId: newLinkedMemberId })
      .where(eq(familyMemberships.id, membershipId))
      .returning();
    if (role !== existing.role) {
      await logActivity({
        familyId: req.familyId,
        actor: req.user,
        action: "space_role_changed",
        target: existing.userId,
        details: { from: existing.role, to: role },
      });
    }
    if (newLinkedMemberId !== existing.linkedMemberId) {
      // Nouvelle fiche reliée : rôles posés avant la liaison retirés, statut
      // à jour ; l'ancienne fiche (adolescent) redevient gérée par les parents.
      const removed = await afterFicheLinked({ memberId: newLinkedMemberId, userId: existing.userId, role });
      if (existing.linkedMemberId) await afterFicheUnlinked(existing.linkedMemberId);
      await logActivity({
        familyId: req.familyId,
        actor: req.user,
        action: "account_linked",
        member: newFiche,
        target: existing.userId,
        details: { via: "parent" },
      });
      await logRolesAutoRevoked({ familyId: req.familyId, actor: req.user, member: newFiche, removed });
    } else if (newLinkedMemberId) {
      // Le lien « Parent » suit le rôle d'administrateur ; le statut suit le rôle.
      const roleChanged = (role === "parent") !== (existing.role === "parent");
      await db
        .update(members)
        .set({
          status: statusForLinkedFiche(role, newFiche?.dateOfBirth, newFiche?.status),
          ...(roleChanged ? (role === "parent" ? { kinship: "parent", kinshipRelatedMemberId: null } : { kinship: null }) : {}),
        })
        .where(eq(members.id, newLinkedMemberId));
    }
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Retirer l'accès d'un membre à la famille — réservé aux Parents, jamais
// applicable à l'Administrateur familial A1 (UC-06, section 9.2). Sa fiche
// est archivée s'il est adulte (lib/archive.js), rendue aux parents s'il est
// adolescent ; ses rôles de dossier et ses notifications de cette famille
// disparaissent.
router.delete("/", requireFamilyMembership(resolveFamilyIdFromMembershipId, { roles: ["parent"] }), async (req, res) => {
  try {
    const id = parseId(req.query.id);
    if (!id) return res.status(400).json({ error: INVALID_ID });

    const [existing] = await db.select().from(familyMemberships).where(eq(familyMemberships.id, id));
    if (!existing) return res.status(404).json({ error: "Introuvable" });
    if (existing.isPrimaryAdmin) {
      return res.status(403).json({ error: "L'administrateur familial ne peut pas être retiré de l'espace" });
    }

    await archiveFicheOfLeavingAccount(existing, { actor: req.user, reason: "removed" });
    await db.delete(familyMemberships).where(eq(familyMemberships.id, id));

    // Ses rôles de dossier (Axe 2) dans cette famille tombent avec lui :
    // ils ne doivent pas se réactiver s'il était réinvité plus tard.
    const familyMemberIds = (
      await db.select({ id: members.id }).from(members).where(eq(members.familyId, req.familyId))
    ).map((m) => m.id);
    let rolesRemoved = 0;
    if (familyMemberIds.length > 0) {
      rolesRemoved = (
        await db
          .delete(documentRoles)
          .where(and(eq(documentRoles.userId, existing.userId), inArray(documentRoles.memberId, familyMemberIds)))
          .returning({ id: documentRoles.id })
      ).length;
    }
    await logActivity({
      familyId: req.familyId,
      actor: req.user,
      action: "account_removed",
      target: existing.userId,
      details: { rolesRemoved },
    });
    // Ses notifications de cette famille aussi (elles décrivent des dossiers
    // auxquels il n'a plus accès).
    await db
      .delete(notifications)
      .where(and(eq(notifications.userId, existing.userId), eq(notifications.familyId, req.familyId)));

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
