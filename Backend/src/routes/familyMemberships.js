import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { familyMemberships, users, members } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";

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
          linkedMemberId: familyMemberships.linkedMemberId,
          createdAt: familyMemberships.createdAt,
          userId: users.id,
          name: users.name,
          email: users.email,
        })
        .from(familyMemberships)
        .innerJoin(users, eq(familyMemberships.userId, users.id))
        .where(eq(familyMemberships.familyId, req.familyId));
      res.json(rows);
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

    // Si on passe (ou reste) au rôle "dependent", une fiche liée est
    // obligatoire — soit fournie maintenant, soit déjà présente avant.
    let newLinkedMemberId = existing.linkedMemberId;
    if (role === "dependent") {
      const parsedId = parseInt(linkedMemberId);
      if (parsedId) {
        const [member] = await db.select().from(members).where(eq(members.id, parsedId));
        if (!member || member.familyId !== req.familyId) {
          return res.status(400).json({ error: "Fiche membre introuvable dans cette famille" });
        }
        newLinkedMemberId = parsedId;
      } else if (!existing.linkedMemberId) {
        return res.status(400).json({ error: "Choisissez la fiche membre correspondant à cette personne" });
      }
    } else {
      // On quitte le rôle dépendant : le lien n'a plus lieu d'être
      newLinkedMemberId = null;
    }

    const [updated] = await db
      .update(familyMemberships)
      .set({ role, linkedMemberId: newLinkedMemberId })
      .where(eq(familyMemberships.id, membershipId))
      .returning();
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Retirer l'accès d'un membre à la famille — réservé aux Parents
router.delete("/", requireFamilyMembership(resolveFamilyIdFromMembershipId, { roles: ["parent"] }), async (req, res) => {
  try {
    const id = parseInt(req.query.id ?? "");
    if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });
    await db.delete(familyMemberships).where(eq(familyMemberships.id, id));
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;