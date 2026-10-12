import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { treatments, treatmentMedications } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdForListQuery, familyIdFromMemberId, familyIdFromResource } from "../lib/familyResolvers.js";
import { canWriteMember, readableScope } from "../lib/documentAccess.js";
import { INVALID_DATE, INVALID_ID, TIME_PATTERN, isIsoDate, parseId, tooLong } from "../lib/validation.js";

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

const optionalText = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

// Normalise et valide la liste de médicaments envoyée par le formulaire —
// un traitement doit obligatoirement concerner au moins un médicament.
// Heures de prise valides (HH:MM, 00:00 à 23:59), sans doublon, triées.
function sanitizeIntakeTimes(times) {
  if (!Array.isArray(times)) return [];
  return [...new Set(times.filter((t) => typeof t === "string" && TIME_PATTERN.test(t.trim())).map((t) => t.trim()))].sort();
}

function sanitizeMedications(medications) {
  if (!Array.isArray(medications)) return [];
  return medications
    .filter((m) => typeof m?.name === "string" && m.name.trim())
    .map((m) => ({
      // Identifiant d'un médicament existant (modification) : conservé pour le
      // mettre à jour sur place et garder son historique de prises.
      id: parseId(m.id),
      name: m.name.trim(),
      dosage: optionalText(m.dosage),
      frequency: optionalText(m.frequency),
      duration: optionalText(m.duration),
      intakeTimes: sanitizeIntakeTimes(m.intakeTimes),
    }));
}

// Longueurs maximales (varchar de db/schema.js), traitement et médicaments.
function tooLongTreatment(values, meds) {
  return (
    tooLong([
      [values.disease, 255, "Maladie ou motif"],
      [values.prescribedBy, 255, "Prescripteur"],
    ]) ??
    meds.map((m) => tooLong([[m.name, 255, "Médicament"], [m.dosage, 100, "Posologie"], [m.frequency, 100, "Fréquence"], [m.duration, 100, "Durée"]])).find(Boolean) ??
    null
  );
}

// Dates du traitement : AAAA-MM-JJ réelles, fin postérieure au début.
function invalidDates(startDate, endDate) {
  if (startDate && !isIsoDate(startDate)) return INVALID_DATE;
  if (endDate && !isIsoDate(endDate)) return INVALID_DATE;
  if (startDate && endDate && endDate < startDate) return "La date de fin doit être postérieure à la date de début";
  return null;
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
      const { disease, isActive, notes, medications } = req.body;
      const memberId = parseId(req.body.memberId);
      const meds = sanitizeMedications(medications);

      if (!memberId || typeof disease !== "string" || !disease.trim()) {
        return res.status(400).json({ error: "Données manquantes" });
      }
      if (meds.length === 0) {
        return res.status(400).json({ error: "Ajoutez au moins un médicament pour ce traitement" });
      }
      const values = {
        disease: disease.trim(),
        startDate: req.body.startDate || null,
        endDate: req.body.endDate || null,
        prescribedBy: optionalText(req.body.prescribedBy),
      };
      const invalid = invalidDates(values.startDate, values.endDate) ?? tooLongTreatment(values, meds);
      if (invalid) return res.status(400).json({ error: invalid });

      // Axe 2 — seuls le Titulaire, le Gestionnaire de ce dossier, ou un Parent
      // (Admin), peuvent déclarer un traitement.
      if (!(await canWriteMember(req, memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      const [created] = await db
        .insert(treatments)
        .values({
          memberId,
          ...values,
          isActive: isActive !== false,
          notes: typeof notes === "string" && notes ? notes : null,
        })
        .returning();

      const insertedMeds = await db
        .insert(treatmentMedications)
        .values(meds.map(({ id: _id, ...m }) => ({ ...m, treatmentId: created.id })))
        .returning();

      res.status(201).json({ ...created, medications: insertedMeds });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Modification. Les champs absents de la requête gardent leur valeur — en
// particulier, un traitement arrêté n'est pas réactivé si isActive est absent.
router.put(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(treatments, req.body.id)),
  async (req, res) => {
    try {
      const body = req.body;
      const meds = sanitizeMedications(body.medications);

      if (typeof body.disease !== "string" || !body.disease.trim()) {
        return res.status(400).json({ error: "Données manquantes" });
      }
      if (meds.length === 0) {
        return res.status(400).json({ error: "Ajoutez au moins un médicament pour ce traitement" });
      }
      if ("isActive" in body && typeof body.isActive !== "boolean") {
        return res.status(400).json({ error: "Statut du traitement invalide" });
      }

      const treatmentId = parseId(body.id);
      if (!treatmentId) return res.status(400).json({ error: INVALID_ID });

      const [existing] = await db.select().from(treatments).where(eq(treatments.id, treatmentId));
      if (!existing) return res.status(404).json({ error: "Traitement introuvable" });
      if (!(await canWriteMember(req, existing.memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      const changes = { disease: body.disease.trim() };
      if ("startDate" in body) changes.startDate = body.startDate || null;
      if ("endDate" in body) changes.endDate = body.endDate || null;
      if ("prescribedBy" in body) changes.prescribedBy = optionalText(body.prescribedBy);
      if ("notes" in body) changes.notes = typeof body.notes === "string" && body.notes ? body.notes : null;
      if ("isActive" in body) changes.isActive = body.isActive;
      const startDate = "startDate" in changes ? changes.startDate : existing.startDate;
      const endDate = "endDate" in changes ? changes.endDate : existing.endDate;
      const invalid =
        ("startDate" in changes && changes.startDate && !isIsoDate(changes.startDate)) ||
        ("endDate" in changes && changes.endDate && !isIsoDate(changes.endDate))
          ? INVALID_DATE
          : invalidDates(startDate, endDate) ?? tooLongTreatment(changes, meds);
      if (invalid) return res.status(400).json({ error: invalid });

      const [updated] = await db.update(treatments).set(changes).where(eq(treatments.id, treatmentId)).returning();

      // Synchronise les médicaments : ceux qui existent déjà sont mis à jour
      // SUR PLACE (leur historique de prises, rattaché au médicament, est
      // conservé) ; les nouveaux sont créés ; ceux retirés du traitement sont
      // supprimés. Les supprimer puis tout recréer effaçait l'historique.
      const existingIds = new Set(
        (await db.select({ id: treatmentMedications.id }).from(treatmentMedications).where(eq(treatmentMedications.treatmentId, treatmentId))).map((r) => r.id)
      );
      const kept = new Set();
      const insertedMeds = [];
      for (const { id: medId, ...med } of meds) {
        if (medId && existingIds.has(medId)) {
          const [row] = await db.update(treatmentMedications).set(med).where(eq(treatmentMedications.id, medId)).returning();
          kept.add(medId);
          insertedMeds.push(row);
        } else {
          const [row] = await db.insert(treatmentMedications).values({ ...med, treatmentId }).returning();
          insertedMeds.push(row);
        }
      }
      const removed = [...existingIds].filter((medId) => !kept.has(medId));
      if (removed.length > 0) await db.delete(treatmentMedications).where(inArray(treatmentMedications.id, removed));

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
      const id = parseId(req.query.id);
      if (!id) return res.status(400).json({ error: INVALID_ID });

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
