import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { vaccinations } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdForListQuery, familyIdFromMemberId, familyIdFromResource } from "../lib/familyResolvers.js";
import { canWriteMember, readableScope } from "../lib/documentAccess.js";
import { localDate } from "../lib/time.js";

const router = Router();

// Statut du rappel d'une vaccination : null (aucun rappel prévu) | "a_faire"
// (date à venir) | "en_retard" (date passée, aucune dose enregistrée) | "fait".
export function boosterStatus(v, today = localDate()) {
  if (!v.nextDoseDate) return null;
  if (v.boosterDoneVaccinationId) return "fait";
  return v.nextDoseDate < today ? "en_retard" : "a_faire";
}

// « Rappel effectué » : enregistre la nouvelle dose (même vaccin, date du
// jour par défaut) et clôt le rappel de la vaccination d'origine.
router.post(
  "/:id/booster-done",
  requireFamilyMembership((req) => familyIdFromResource(vaccinations, req.params.id)),
  async (req, res) => {
    try {
      const [original] = await db.select().from(vaccinations).where(eq(vaccinations.id, parseInt(req.params.id)));
      if (!original) return res.status(404).json({ error: "Vaccination introuvable" });
      if (!(await canWriteMember(req, original.memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }
      if (!original.nextDoseDate) return res.status(400).json({ error: "Aucun rappel prévu pour cette vaccination" });
      if (original.boosterDoneVaccinationId) return res.status(409).json({ error: "Ce rappel est déjà enregistré" });
      const { vaccineName, dateAdministered, nextDoseDate, administeredBy, lotNumber, notes } = req.body;
      const date = dateAdministered || localDate();
      if (date > localDate()) return res.status(400).json({ error: "La date de la dose ne peut pas être dans le futur" });
      const [dose] = await db
        .insert(vaccinations)
        .values({
          memberId: original.memberId,
          vaccineName: vaccineName?.trim() || original.vaccineName,
          dateAdministered: date,
          nextDoseDate: nextDoseDate || null,
          administeredBy: administeredBy || original.administeredBy || null,
          lotNumber: lotNumber || null,
          notes: notes || null,
        })
        .returning();
      await db.update(vaccinations).set({ boosterDoneVaccinationId: dose.id }).where(eq(vaccinations.id, original.id));
      res.status(201).json({ ...dose, boosterStatus: boosterStatus(dose) });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

router.get("/", requireFamilyMembership(familyIdForListQuery), async (req, res) => {
  try {
    // Seules les fiches dont le dossier est lisible par ce compte (voir
    // lib/documentAccess.js) ; ?memberId= sur une fiche non lisible → 403.
    const memberIds = await readableScope(req);
    if (!memberIds) return res.status(403).json({ error: "Accès refusé à ce dossier" });
    if (memberIds.length === 0) return res.json([]);
    const all = await db.select().from(vaccinations).where(inArray(vaccinations.memberId, memberIds)).orderBy(vaccinations.dateAdministered);
    const today = localDate();
    res.json(all.map((v) => ({ ...v, boosterStatus: boosterStatus(v, today) })));
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
      if (!(await canWriteMember(req, existing.memberId))) {
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
      if (!(await canWriteMember(req, parseInt(memberId)))) {
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
      if (!(await canWriteMember(req, existing.memberId))) {
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