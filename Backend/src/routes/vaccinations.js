import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { vaccinations } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdForListQuery, familyIdFromMemberId, familyIdFromResource } from "../lib/familyResolvers.js";
import { canWriteMember, readableScope } from "../lib/documentAccess.js";
import { localDate } from "../lib/time.js";
import { INVALID_DATE, INVALID_ID, isIsoDate, parseId, tooLong } from "../lib/validation.js";

const router = Router();

// Statut du rappel d'une vaccination : null (aucun rappel prévu) | "a_faire"
// (date à venir) | "en_retard" (date passée, aucune dose enregistrée) | "fait".
export function boosterStatus(v, today = localDate()) {
  if (!v.nextDoseDate) return null;
  if (v.boosterDoneVaccinationId) return "fait";
  return v.nextDoseDate < today ? "en_retard" : "a_faire";
}

const optionalText = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

// Contrôles communs à la saisie d'une dose : dates AAAA-MM-JJ réelles, dose
// jamais datée du futur (partout, comme « Rappel effectué »), rappel prévu
// après la dose, longueurs des champs (varchar de db/schema.js).
function invalidVaccination({ vaccineName, dateAdministered, nextDoseDate, administeredBy, lotNumber }) {
  if (!isIsoDate(dateAdministered)) return INVALID_DATE;
  if (dateAdministered > localDate()) return "La date de la dose ne peut pas être dans le futur";
  if (nextDoseDate) {
    if (!isIsoDate(nextDoseDate)) return INVALID_DATE;
    if (nextDoseDate < dateAdministered) return "Le rappel doit être prévu après la date de la dose";
  }
  return tooLong([
    [vaccineName, 255, "Vaccin"],
    [administeredBy, 255, "Administré par"],
    [lotNumber, 100, "Numéro de lot"],
  ]);
}

// « Rappel effectué » : enregistre la nouvelle dose (même vaccin, date du
// jour par défaut) et clôt le rappel de la vaccination d'origine.
router.post(
  "/:id/booster-done",
  requireFamilyMembership((req) => familyIdFromResource(vaccinations, req.params.id)),
  async (req, res) => {
    try {
      const [original] = await db.select().from(vaccinations).where(eq(vaccinations.id, parseId(req.params.id)));
      if (!original) return res.status(404).json({ error: "Vaccination introuvable" });
      if (!(await canWriteMember(req, original.memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }
      if (!original.nextDoseDate) return res.status(400).json({ error: "Aucun rappel prévu pour cette vaccination" });
      if (original.boosterDoneVaccinationId) return res.status(409).json({ error: "Ce rappel est déjà enregistré" });
      const { notes } = req.body;
      const values = {
        vaccineName: optionalText(req.body.vaccineName) || original.vaccineName,
        dateAdministered: req.body.dateAdministered || localDate(),
        nextDoseDate: req.body.nextDoseDate || null,
        administeredBy: optionalText(req.body.administeredBy) || original.administeredBy || null,
        lotNumber: optionalText(req.body.lotNumber),
      };
      const invalid = invalidVaccination(values);
      if (invalid) return res.status(400).json({ error: invalid });
      const [dose] = await db
        .insert(vaccinations)
        .values({
          memberId: original.memberId,
          ...values,
          notes: typeof notes === "string" && notes ? notes : null,
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

// Modification. Les champs absents de la requête gardent leur valeur ; un
// nom de vaccin vide est refusé.
router.put(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(vaccinations, req.body.id)),
  async (req, res) => {
    try {
      const body = req.body;
      const id = parseId(body.id);
      if (!id) return res.status(400).json({ error: INVALID_ID });

      const [existing] = await db.select().from(vaccinations).where(eq(vaccinations.id, id));
      if (!existing) return res.status(404).json({ error: "Vaccination introuvable" });
      if (!(await canWriteMember(req, existing.memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      const changes = {};
      if ("vaccineName" in body) {
        if (typeof body.vaccineName !== "string" || !body.vaccineName.trim()) {
          return res.status(400).json({ error: "Le nom du vaccin est requis" });
        }
        changes.vaccineName = body.vaccineName.trim();
      }
      if ("dateAdministered" in body) changes.dateAdministered = body.dateAdministered;
      if ("nextDoseDate" in body) changes.nextDoseDate = body.nextDoseDate || null;
      if ("administeredBy" in body) changes.administeredBy = optionalText(body.administeredBy);
      if ("lotNumber" in body) changes.lotNumber = optionalText(body.lotNumber);
      if ("notes" in body) changes.notes = typeof body.notes === "string" && body.notes ? body.notes : null;

      const invalid = invalidVaccination({ ...existing, ...changes });
      if (invalid) return res.status(400).json({ error: invalid });

      if (Object.keys(changes).length === 0) return res.json(existing);
      const [updated] = await db.update(vaccinations).set(changes).where(eq(vaccinations.id, id)).returning();
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
      const { vaccineName, dateAdministered, notes } = req.body;
      const memberId = parseId(req.body.memberId);
      if (!memberId || typeof vaccineName !== "string" || !vaccineName.trim() || !dateAdministered) {
        return res.status(400).json({ error: "Données manquantes" });
      }
      const values = {
        vaccineName: vaccineName.trim(),
        dateAdministered,
        nextDoseDate: req.body.nextDoseDate || null,
        administeredBy: optionalText(req.body.administeredBy),
        lotNumber: optionalText(req.body.lotNumber),
      };
      const invalid = invalidVaccination(values);
      if (invalid) return res.status(400).json({ error: invalid });
      if (!(await canWriteMember(req, memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }
      const [created] = await db
        .insert(vaccinations)
        .values({ memberId, ...values, notes: typeof notes === "string" && notes ? notes : null })
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
      const id = parseId(req.query.id);
      if (!id) return res.status(400).json({ error: INVALID_ID });

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
