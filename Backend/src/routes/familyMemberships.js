import { Router } from "express";
import { eq, and, sql, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { familyMemberships, users, members, documentRoles } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { canWriteMember } from "../lib/documentAccess.js";
import { ageOn, effectiveRole } from "../lib/family.js";

const router = Router();

const ALLOWED_ROLES = ["parent", "adult", "dependent"];
const MAX_PARENTS = 2;

// Liste des comptes ayant accès à la famille, avec leur rôle — visible à
// tous les membres de la famille (pas seulement les Parents).
router.get(
  "/",
  requireFamilyMembership((req) => parseInt(req.query.familyId) || null),
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
  const id = parseInt(req.body?.id ?? req.query?.id);
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

    const membershipId = parseInt(id);
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
    // "dependent". Un Parent relie ici le compte d'un AUTRE ; pour soi-même,
    // c'est POST /api/members/claim (on ne s'attribue pas une fiche qu'on
    // ne gère pas).
    let newLinkedMemberId = existing.linkedMemberId;
    const parsedId = parseInt(linkedMemberId);
    if (parsedId && parsedId !== existing.linkedMemberId) {
      if (existing.userId === req.user.id) {
        return res.status(403).json({ error: "Utilisez « Ma fiche » pour désigner votre propre fiche" });
      }
      const [member] = await db.select().from(members).where(eq(members.id, parsedId));
      if (!member || member.familyId !== req.familyId) {
        return res.status(400).json({ error: "Fiche membre introuvable dans cette famille" });
      }
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
      newLinkedMemberId = parsedId;
    }
    if (role === "dependent" && !newLinkedMemberId) {
      return res.status(400).json({ error: "Choisissez la fiche membre correspondant à cette personne" });
    }

    const [updated] = await db
      .update(familyMemberships)
      .set({ role, linkedMemberId: newLinkedMemberId })
      .where(eq(familyMemberships.id, membershipId))
      .returning();
    // Le lien « Parent » suit le rôle d'administrateur.
    if (newLinkedMemberId && (role === "parent") !== (existing.role === "parent")) {
      await db
        .update(members)
        .set(role === "parent" ? { kinship: "parent", kinshipRelatedMemberId: null } : { kinship: null })
        .where(eq(members.id, newLinkedMemberId));
    }
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Retirer l'accès d'un membre à la famille — réservé aux Parents, jamais
// applicable à l'Administrateur familial A1 (UC-06, section 9.2).
router.delete("/", requireFamilyMembership(resolveFamilyIdFromMembershipId, { roles: ["parent"] }), async (req, res) => {
  try {
    const id = parseInt(req.query.id ?? "");
    if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });

    const [existing] = await db.select().from(familyMemberships).where(eq(familyMemberships.id, id));
    if (!existing) return res.status(404).json({ error: "Introuvable" });
    if (existing.isPrimaryAdmin) {
      return res.status(403).json({ error: "L'administrateur familial ne peut pas être retiré de l'espace" });
    }

    await db.delete(familyMemberships).where(eq(familyMemberships.id, id));

    // Ses rôles de dossier (Axe 2) dans cette famille tombent avec lui :
    // ils ne doivent pas se réactiver s'il était réinvité plus tard.
    const familyMemberIds = (
      await db.select({ id: members.id }).from(members).where(eq(members.familyId, req.familyId))
    ).map((m) => m.id);
    if (familyMemberIds.length > 0) {
      await db
        .delete(documentRoles)
        .where(and(eq(documentRoles.userId, existing.userId), inArray(documentRoles.memberId, familyMemberIds)));
    }

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;