import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { treatments, treatmentMedications } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdForListQuery, familyIdFromMemberId, familyIdFromResource } from "../lib/familyResolvers.js";
import { canWriteMember, readableScope } from "../lib/documentAccess.js";

const router = Router();

// Attache à chaque traitement la liste de ses médicaments (nom, posologie,
// fréquence, durée) — un traitement (une maladie) peut en regrouper plusieurs.
async function attachMedications(rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const meds = await db
    .select()
    .from(treatmentMedications)
    .where(inArray(treatmentMedications.treatmentId, ids))
    .orderBy(treatmentMedications.id);
  const byTreatment = {};
  for (const m of meds) {
    (byTreatment[m.treatmentId] ??= []).push(m);
  }
  return rows.map((r) => ({ ...r, medications: byTreatment[r.id] ?? [] }));
}

// Normalise et valide la liste de médicaments envoyée par le formulaire —
// un traitement doit obligatoirement concerner au moins un médicament.
// Heures de prise valides (HH:MM, 00:00 à 23:59), sans doublon, triées.
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
function sanitizeIntakeTimes(times) {
  if (!Array.isArray(times)) return [];
  return [...new Set(times.filter((t) => typeof t === "string" && TIME_PATTERN.test(t.trim())).map((t) => t.trim()))].sort();
}

function sanitizeMedications(medications) {
  if (!Array.isArray(medications)) return [];
  return medications
    .filter((m) => m?.name?.trim())
    .map((m) => ({
      name: m.name.trim(),
      dosage: m.dosage?.trim() || null,
      frequency: m.frequency?.trim() || null,
      duration: m.duration?.trim() || null,
      intakeTimes: sanitizeIntakeTimes(m.intakeTimes),
    }));
}

router.get("/", requireFamilyMembership(familyIdForListQuery), async (req, res) => {
  try {
    // Seules les fiches dont le dossier est lisible par ce compte (voir
    // lib/documentAccess.js) ; ?memberId= sur une fiche non lisible → 403.
    const memberIds = await readableScope(req);
    if (!memberIds) return res.status(403).json({ error: "Accès refusé à ce dossier" });
    if (memberIds.length === 0) return res.json([]);
    const all = await db.select().from(treatments).where(inArray(treatments.memberId, memberIds)).orderBy(treatments.createdAt);
    res.json(await attachMedications(all));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post(
  "/",
  requireFamilyMembership((req) => familyIdFromMemberId(req.body.memberId)),
  async (req, res) => {
    try {
      const { memberId, disease, startDate, endDate, prescribedBy, isActive, notes, medications } = req.body;
      const meds = sanitizeMedications(medications);

      if (!memberId || !disease?.trim()) {
        return res.status(400).json({ error: "Données manquantes" });
      }
      if (meds.length === 0) {
        return res.status(400).json({ error: "Ajoutez au moins un médicament pour ce traitement" });
      }

      // Axe 2 — seuls le Titulaire, le Gestionnaire de ce dossier, ou un Parent
      // (Admin), peuvent déclarer un traitement.
      if (!(await canWriteMember(req, parseInt(memberId)))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      const [created] = await db
        .insert(treatments)
        .values({
          memberId: parseInt(memberId),
          disease: disease.trim(),
          startDate: startDate || null,
          endDate: endDate || null,
          prescribedBy: prescribedBy || null,
          isActive: isActive !== false,
          notes: notes || null,
        })
        .returning();

      const insertedMeds = await db
        .insert(treatmentMedications)
        .values(meds.map((m) => ({ ...m, treatmentId: created.id })))
        .returning();

      res.status(201).json({ ...created, medications: insertedMeds });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

router.put(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(treatments, req.body.id)),
  async (req, res) => {
    try {
      const { id, disease, startDate, endDate, prescribedBy, isActive, notes, medications } = req.body;
      const meds = sanitizeMedications(medications);

      if (!disease?.trim()) {
        return res.status(400).json({ error: "Données manquantes" });
      }
      if (meds.length === 0) {
        return res.status(400).json({ error: "Ajoutez au moins un médicament pour ce traitement" });
      }

      const treatmentId = parseInt(id);

      const [existing] = await db.select({ memberId: treatments.memberId }).from(treatments).where(eq(treatments.id, treatmentId));
      if (!existing) return res.status(404).json({ error: "Traitement introuvable" });
      if (!(await canWriteMember(req, existing.memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      const [updated] = await db
        .update(treatments)
        .set({
          disease: disease.trim(),
          startDate: startDate || null,
          endDate: endDate || null,
          prescribedBy: prescribedBy || null,
          isActive: isActive !== false,
          notes: notes || null,
        })
        .where(eq(treatments.id, treatmentId))
        .returning();

      // Remplace entièrement la liste des médicaments par celle envoyée.
      await db.delete(treatmentMedications).where(eq(treatmentMedications.treatmentId, treatmentId));
      const insertedMeds = await db
        .insert(treatmentMedications)
        .values(meds.map((m) => ({ ...m, treatmentId })))
        .returning();

      res.json({ ...updated, medications: insertedMeds });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Suppression — Titulaire, Gestionnaire de ce dossier, ou Parent (Admin).
// Les médicaments liés sont supprimés en cascade automatiquement (contrainte
// onDelete: cascade sur treatmentId).
router.delete(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(treatments, req.query.id)),
  async (req, res) => {
    try {
      const id = parseInt(req.query.id ?? "");
      if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });

      const [existing] = await db.select({ memberId: treatments.memberId }).from(treatments).where(eq(treatments.id, id));
      if (!existing) return res.status(404).json({ error: "Traitement introuvable" });
      if (!(await canWriteMember(req, existing.memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      await db.delete(treatments).where(eq(treatments.id, id));
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;