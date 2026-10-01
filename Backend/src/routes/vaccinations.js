import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { vaccinations, members } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdFromMemberId, familyIdFromResource } from "../lib/familyResolvers.js";
import { canWriteDocument } from "../lib/documentAccess.js";

const router = Router();

async function resolveForGet(req) {
  if (req.query.familyId) return parseInt(req.query.familyId) || null;
  if (req.query.memberId) return familyIdFromMemberId(req.query.memberId);
  return null;
}

router.get("/", requireFamilyMembership(resolveForGet), async (req, res) => {
  try {
    // Un Dépendant ne voit que les vaccinations de sa propre fiche liée.
    if (req.membership.role === "dependent") {
      if (!req.membership.linkedMemberId) return res.json([]);
      const own = await db
        .select()
        .from(vaccinations)
        .where(eq(vaccinations.memberId, req.membership.linkedMemberId))
        .orderBy(vaccinations.dateAdministered);
      return res.json(own);
    }

    const { memberId, familyId } = req.query;

    if (memberId) {
      const all = await db.select().from(vaccinations).where(eq(vaccinations.memberId, parseInt(memberId))).orderBy(vaccinations.dateAdministered);
      return res.json(all);
    }

    const familyMembers = await db.select({ id: members.id }).from(members).where(eq(members.familyId, parseInt(familyId)));
    if (familyMembers.length === 0) return res.json([]);
    const memberIds = familyMembers.map((m) => m.id);
    const all = await db.select().from(vaccinations).where(inArray(vaccinations.memberId, memberIds)).orderBy(vaccinations.dateAdministered);
    res.json(all);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(vaccinations, req.body.id)),
  async (req, res) => {
    try {
      const { id, vaccineName, dateAdministered, nextDoseDate, administeredBy, lotNumber, notes } = req.body;
      if (!id) return res.status(400).json({ error: "ID manquant" });

      const [existing] = await db.select({ memberId: vaccinations.memberId }).from(vaccinations).where(eq(vaccinations.id, parseInt(id)));
      if (!existing) return res.status(404).json({ error: "Vaccination introuvable" });
      if (!(await canWriteDocument(existing.memberId, req.user.id, req.membership))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      const [updated] = await db
        .update(vaccinations)
        .set({
          vaccineName: vaccineName?.trim(),
          dateAdministered: dateAdministered || undefined,
          nextDoseDate: nextDoseDate || null,
          administeredBy: administeredBy || null,
          lotNumber: lotNumber || null,
          notes: notes || null,
        })
        .where(eq(vaccinations.id, parseInt(id)))
        .returning();
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

router.post(
  "/",
  requireFamilyMembership((req) => familyIdFromMemberId(req.body.memberId)),
  async (req, res) => {
    try {
      const { memberId, vaccineName, dateAdministered, nextDoseDate, administeredBy, lotNumber, notes } = req.body;
      if (!memberId || !vaccineName?.trim() || !dateAdministered) {
        return res.status(400).json({ error: "Données manquantes" });
      }
      if (!(await canWriteDocument(parseInt(memberId), req.user.id, req.membership))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }
      const [created] = await db
        .insert(vaccinations)
        .values({
          memberId: parseInt(memberId),
          vaccineName: vaccineName.trim(),
          dateAdministered,
          nextDoseDate: nextDoseDate || null,
          administeredBy: administeredBy || null,
          lotNumber: lotNumber || null,
          notes: notes || null,
        })
        .returning();
      res.status(201).json(created);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Suppression — Titulaire, Gestionnaire de ce dossier, ou Parent (Admin).
router.delete(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(vaccinations, req.query.id)),
  async (req, res) => {
    try {
      const id = parseInt(req.query.id ?? "");
      if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });

      const [existing] = await db.select({ memberId: vaccinations.memberId }).from(vaccinations).where(eq(vaccinations.id, id));
      if (!existing) return res.status(404).json({ error: "Vaccination introuvable" });
      if (!(await canWriteDocument(existing.memberId, req.user.id, req.membership))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      await db.delete(vaccinations).where(eq(vaccinations.id, id));
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;