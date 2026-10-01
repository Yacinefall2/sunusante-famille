import { Router } from "express";
import { eq, inArray, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { families, familyMemberships } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";

const router = Router();

// Ne renvoie que les familles auxquelles l'utilisateur connecté appartient
router.get("/", async (req, res) => {
  try {
    const memberships = await db
      .select({ familyId: familyMemberships.familyId })
      .from(familyMemberships)
      .where(eq(familyMemberships.userId, req.user.id));

    if (memberships.length === 0) return res.json([]);

    const familyIds = memberships.map((m) => m.familyId);
    const all = await db.select().from(families).where(inArray(families.id, familyIds)).orderBy(families.createdAt);
    res.json(all);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: "Le nom est requis" });
    }

    // Une personne déjà membre d'une famille (quel que soit son rôle) ne peut
    // pas créer une nouvelle famille — chaque compte appartient à une seule
    // famille à la fois.
    const [existingMembership] = await db
      .select({ id: familyMemberships.id })
      .from(familyMemberships)
      .where(eq(familyMemberships.userId, req.user.id));
    if (existingMembership) {
      return res.status(403).json({
        error: "Vous êtes déjà membre d'une famille. Vous ne pouvez pas en créer une nouvelle.",
      });
    }

    const [created] = await db.insert(families).values({ name: name.trim() }).returning();

    // Le créateur devient automatiquement Parent de la famille qu'il vient de
    // créer, ET Administrateur familial (A1) — seul lui pourra supprimer
    // l'espace ou promouvoir un co-administrateur (Axe 1 du modèle d'acteurs).
    await db.insert(familyMemberships).values({
      userId: req.user.id,
      familyId: created.id,
      role: "parent",
      isPrimaryAdmin: true,
    });

    res.status(201).json(created);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Suppression de l'espace familial — action irréversible réservée à
// l'Administrateur familial (A1), exclue pour le Co-administrateur (A2),
// même si celui-ci a le rôle "parent" (UC-11 / section 9.2).
router.delete(
  "/",
  requireFamilyMembership((req) => parseInt(req.query.id) || null, { roles: ["parent"] }),
  async (req, res) => {
    try {
      if (!req.membership.isPrimaryAdmin) {
        return res.status(403).json({
          error: "Seul l'administrateur qui a créé l'espace familial peut le supprimer",
        });
      }
      await db.delete(families).where(eq(families.id, req.familyId));
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;