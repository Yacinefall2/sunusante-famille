import { Router } from "express";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { medicationIntakes, treatmentMedications, treatments, users } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdForListQuery, familyIdFromMemberId } from "../lib/familyResolvers.js";
import { canWriteMember, isHolder, readableScope } from "../lib/documentAccess.js";
import { markIntakeNotificationsRead } from "../reminders/engine.js";
import { INVALID_ID, parseId } from "../lib/validation.js";
import { consumeIntakeActionToken } from "../lib/push.js";
import { ipRateLimit } from "../lib/rateLimit.js";

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
    const days = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 90);
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

// Charge la prise :id (req.intake).
async function loadIntake(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: INVALID_ID });
    const [intake] = await db.select().from(medicationIntakes).where(eq(medicationIntakes.id, id));
    if (!intake) return res.status(404).json({ error: "Prise introuvable" });
    req.intake = intake;
    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
}

// Enregistre la réponse de req.user à req.intake. Autorisé au titulaire de
// la fiche — adolescent compris, c'est une action sur lui-même (§9.6) — et à
// qui a l'accès complet au dossier (gestionnaire d'un enfant ou d'un proche,
// administrateur).
async function recordResponse(req, res) {
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

const familyOfIntake = (req) => familyIdFromMemberId(req.intake.memberId);

// Répondre à une prise depuis l'application (session ouverte).
router.post("/:id/respond", loadIntake, requireFamilyMembership(familyOfIntake), recordResponse);

// ── Réponse depuis une notification push (boutons « Pris » / « Pas pris ») ──
// Sans session : l'application peut être fermée depuis des jours et le
// cookie expiré. Le jeton d'action, reçu dans la notification, tient lieu
// d'autorisation : usage unique, valable 24 h, pour CETTE prise et CE compte
// (lib/push.js). Les droits sont revérifiés comme pour une réponse ordinaire :
// un accès retiré entre-temps refuse la réponse.
export const intakeActionRouter = Router();

const actionLimit = ipRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: "Trop de tentatives : réessayez dans quelques minutes",
});

intakeActionRouter.post(
  "/:id/respond-with-token",
  actionLimit,
  loadIntake,
  async (req, res, next) => {
    try {
      // Réponse invalide : refusée AVANT de consommer le jeton.
      if (!RESPONSES.includes(req.body?.status)) return res.status(400).json({ error: "Réponse invalide" });
      const userId = await consumeIntakeActionToken(req.body?.token, req.intake.id);
      if (!userId) return res.status(401).json({ error: "Lien de réponse expiré ou déjà utilisé : ouvrez l'application" });
      const [user] = await db
        .select({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, userId));
      if (!user?.emailVerified) return res.status(403).json({ error: "Accès refusé" });
      req.user = user;
      next();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  },
  requireFamilyMembership(familyOfIntake),
  recordResponse
);

export default router;
