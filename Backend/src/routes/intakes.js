import { Router } from "express";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { medicationIntakes, treatmentMedications, treatments } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdForListQuery, familyIdFromMemberId } from "../lib/familyResolvers.js";
import { canWriteMember, isHolder, readableScope } from "../lib/documentAccess.js";
import { markIntakeNotificationsRead } from "../reminders/engine.js";

// Prises de médicament : réponse « pris » / « pas pris » (UC-20, UC-44) et
// historique des prises d'un dossier.
const router = Router();

const RESPONSES = ["taken", "not_taken"];

// Historique des prises des fiches lisibles (par défaut les 14 derniers jours).
router.get("/", requireFamilyMembership(familyIdForListQuery), async (req, res) => {
  try {
    const memberIds = await readableScope(req);
    if (!memberIds) return res.status(403).json({ error: "Accès refusé à ce dossier" });
    if (memberIds.length === 0) return res.json([]);
    const days = Math.min(parseInt(req.query.days) || 14, 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        id: medicationIntakes.id,
        memberId: medicationIntakes.memberId,
        medicationId: medicationIntakes.medicationId,
        treatmentId: treatments.id,
        medicationName: treatmentMedications.name,
        dosage: treatmentMedications.dosage,
        scheduledAt: medicationIntakes.scheduledAt,
        status: medicationIntakes.status,
        respondedAt: medicationIntakes.respondedAt,
      })
      .from(medicationIntakes)
      .innerJoin(treatmentMedications, eq(treatmentMedications.id, medicationIntakes.medicationId))
      .innerJoin(treatments, eq(treatments.id, treatmentMedications.treatmentId))
      .where(and(inArray(medicationIntakes.memberId, memberIds), gte(medicationIntakes.scheduledAt, since)))
      .orderBy(desc(medicationIntakes.scheduledAt));
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Répondre à une prise. Autorisé au titulaire de la fiche — adolescent
// compris, c'est une action sur lui-même (§9.6) — et à qui a l'accès complet
// au dossier (gestionnaire d'un enfant ou d'un proche, administrateur).
router.post(
  "/:id/respond",
  async (req, res, next) => {
    try {
      const [intake] = await db.select().from(medicationIntakes).where(eq(medicationIntakes.id, parseInt(req.params.id)));
      if (!intake) return res.status(404).json({ error: "Prise introuvable" });
      req.intake = intake;
      next();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  },
  requireFamilyMembership((req) => familyIdFromMemberId(req.intake.memberId)),
  async (req, res) => {
    try {
      const { status } = req.body;
      if (!RESPONSES.includes(status)) return res.status(400).json({ error: "Réponse invalide" });
      const { intake } = req;
      if (!isHolder(req, intake.memberId) && !(await canWriteMember(req, intake.memberId))) {
        return res.status(403).json({ error: "Vous ne pouvez pas répondre pour ce dossier" });
      }
      const now = new Date();
      const [updated] = await db
        .update(medicationIntakes)
        .set({ status, respondedByUserId: req.user.id, respondedAt: now })
        .where(eq(medicationIntakes.id, intake.id))
        .returning();
      await markIntakeNotificationsRead(intake.id, now);
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;
