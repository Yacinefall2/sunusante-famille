import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { members, familyMemberships } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { setDocumentRole } from "../lib/documentAccess.js";

// Axe 3 du modèle d'acteurs — statuts valides pour une fiche membre.
const VALID_STATUSES = ["connecte_autonome", "connecte_assiste", "adolescent", "mineur_gere", "non_connecte"];

const router = Router();

// Détermine si la fiche `existing` appartient (guardianUserId) à un compte
// ayant le rôle "parent" dans cette famille — et que ce compte n'est pas
// req.user lui-même. Dans ce cas, aucun autre Parent ne peut modifier ou
// supprimer cette fiche : un parent ne peut jamais toucher aux informations
// d'un autre parent, seul l'intéressé le peut.
async function isOwnedByAnotherParent(existing, familyId, requestingUserId) {
  if (!existing.guardianUserId || existing.guardianUserId === requestingUserId) return false;
  const [ownerMembership] = await db
    .select({ role: familyMemberships.role })
    .from(familyMemberships)
    .where(and(eq(familyMemberships.userId, existing.guardianUserId), eq(familyMemberships.familyId, familyId)));
  return ownerMembership?.role === "parent";
}

router.get(
  "/",
  requireFamilyMembership((req) => parseInt(req.query.familyId) || null),
  async (req, res) => {
    try {
      // Un Dépendant ne voit que sa propre fiche liée, jamais le reste de la
      // famille. Admin et Adulte voient tout, comme avant.
      if (req.membership.role === "dependent") {
        if (!req.membership.linkedMemberId) return res.json([]);
        const own = await db.select().from(members).where(eq(members.id, req.membership.linkedMemberId));
        return res.json(own);
      }

      const all = await db.select().from(members).where(eq(members.familyId, req.familyId));
      res.json(all);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

router.post(
  "/",
  requireFamilyMembership((req) => parseInt(req.body.familyId) || null, { roles: ["parent", "adult"] }),
  async (req, res) => {
    try {
      const { firstName, lastName, dateOfBirth, gender, bloodType, allergies, notes, avatarColor, status } = req.body;
      if (!firstName?.trim() || !lastName?.trim()) {
        return res.status(400).json({ error: "Données manquantes" });
      }
      const [created] = await db
        .insert(members)
        .values({
          familyId: req.familyId,
          // Celui qui crée la fiche en devient responsable (peut la modifier
          // ensuite ; l'Admin peut toujours tout modifier en plus de lui).
          guardianUserId: req.user.id,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          dateOfBirth: dateOfBirth || null,
          gender: gender || null,
          bloodType: bloodType || null,
          allergies: allergies || null,
          notes: notes || null,
          avatarColor: avatarColor || "#3B82F6",
          status: VALID_STATUSES.includes(status) ? status : "connecte_autonome",
        })
        .returning();

      // Axe 2 — enregistre le créateur comme "gestionnaire" de cette fiche.
      // (On ne peut pas encore distinguer "c'est ma propre fiche" de "c'est
      // celle d'un proche" à la création ; le formulaire pourra proposer ce
      // choix dans une prochaine étape pour enregistrer "titulaire" à la place.)
      await setDocumentRole(created.id, req.user.id, "gestionnaire");

      res.status(201).json(created);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Résout la famille d'un membre existant à partir de son id (pour PUT/DELETE,
// qui ne reçoivent que l'id du membre, pas familyId)
async function resolveFamilyIdFromMemberId(req) {
  const id = parseInt(req.body?.id ?? req.query?.id);
  if (!id) return null;
  const [member] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, id));
  return member?.familyId ?? null;
}

// Modifier une fiche — réservé à l'Admin OU au responsable de cette fiche précise
router.put("/", requireFamilyMembership(resolveFamilyIdFromMemberId), async (req, res) => {
  try {
    const { id, firstName, lastName, dateOfBirth, gender, bloodType, allergies, notes, avatarColor, status } = req.body;
    const memberId = parseInt(id);

    const [existing] = await db.select().from(members).where(eq(members.id, memberId));
    if (!existing) return res.status(404).json({ error: "Membre introuvable" });

    const isAdmin = req.membership.role === "parent";
    const isGuardian = existing.guardianUserId === req.user.id;
    if (!isAdmin && !isGuardian) {
      return res.status(403).json({
        error: "Seul un Parent ou la personne qui a créé cette fiche peut la modifier",
      });
    }

    // Un Parent ne peut jamais modifier la fiche d'un AUTRE Parent.
    if (!isGuardian && (await isOwnedByAnotherParent(existing, req.familyId, req.user.id))) {
      return res.status(403).json({
        error: "Un parent ne peut pas modifier les informations d'un autre parent",
      });
    }

    const [updated] = await db
      .update(members)
      .set({
        firstName: firstName?.trim(),
        lastName: lastName?.trim(),
        dateOfBirth: dateOfBirth || null,
        gender: gender || null,
        bloodType: bloodType || null,
        allergies: allergies || null,
        notes: notes || null,
        avatarColor: avatarColor || "#3B82F6",
        ...(VALID_STATUSES.includes(status) ? { status } : {}),
      })
      .where(eq(members.id, memberId))
      .returning();
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Supprimer une fiche — réservé à l'Admin (Parent), sauf la fiche d'un autre Parent
router.delete(
  "/",
  requireFamilyMembership(resolveFamilyIdFromMemberId, { roles: ["parent"] }),
  async (req, res) => {
    try {
      const id = parseInt(req.query.id ?? "");
      if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });

      const [existing] = await db.select().from(members).where(eq(members.id, id));
      if (!existing) return res.status(404).json({ error: "Membre introuvable" });

      if (
        existing.guardianUserId !== req.user.id &&
        (await isOwnedByAnotherParent(existing, req.familyId, req.user.id))
      ) {
        return res.status(403).json({
          error: "Un parent ne peut pas supprimer la fiche d'un autre parent",
        });
      }

      await db.delete(members).where(eq(members.id, id));
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;