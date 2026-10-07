import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { doctorShares, documents, members, users } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdFromMemberId, familyIdFromResource } from "../lib/familyResolvers.js";
import { canSeeDocument, canWriteMember, isHolder } from "../lib/documentAccess.js";
import { DOCTOR_SHARE_DURATIONS, frontendUrl, hashToken, newToken, recipientsFor, shareState } from "../lib/sharing.js";
import { formatDateTime } from "../lib/time.js";
import { notify } from "../reminders/notify.js";

// Partage avec un professionnel de santé (A4) : UC-22 (titulaire), UC-37
// (gestionnaire), A1/A2. Jamais un adolescent (lecture seule).
const router = Router();

const canManageShares = async (req, memberId) => (await canWriteMember(req, memberId)) || (isHolder(req, memberId) && req.membership.role !== "dependent");

export async function notifyShareEvent(share, member, { key, title, body }) {
  const now = new Date();
  for (const user of await recipientsFor(member)) {
    await notify({
      user,
      category: "doctor_share",
      dedupeKey: `share:${share.id}:${key}:${user.id}`,
      title,
      body,
      link: `/partage?fiche=${member.id}`,
      familyId: member.familyId,
      memberId: member.id,
      now,
    });
  }
}

const DURATION_LABEL = { "2h": "2 heures", "24h": "24 heures", "7j": "7 jours" };

function present(share, authorName) {
  return {
    id: share.id,
    memberId: share.memberId,
    includeEssentials: share.includeEssentials,
    includeTreatments: share.includeTreatments,
    includeVaccinations: share.includeVaccinations,
    documentIds: share.documentIds,
    expiresAt: share.expiresAt,
    consumedAt: share.consumedAt,
    revokedAt: share.revokedAt,
    lastViewedAt: share.lastViewedAt,
    createdAt: share.createdAt,
    createdByName: authorName ?? null,
    state: shareState(share),
  };
}

router.get("/", requireFamilyMembership((req) => familyIdFromMemberId(req.query.memberId)), async (req, res) => {
  try {
    const memberId = parseInt(req.query.memberId);
    if (!(await canManageShares(req, memberId))) return res.status(403).json({ error: "Accès refusé aux partages de ce dossier" });
    const rows = await db
      .select({ share: doctorShares, authorName: users.name })
      .from(doctorShares)
      .leftJoin(users, eq(users.id, doctorShares.createdByUserId))
      .where(eq(doctorShares.memberId, memberId))
      .orderBy(desc(doctorShares.createdAt))
      .limit(50);
    res.json(rows.map((r) => present(r.share, r.authorName)));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/", requireFamilyMembership((req) => familyIdFromMemberId(req.body.memberId)), async (req, res) => {
  try {
    const memberId = parseInt(req.body.memberId);
    if (!(await canWriteMember(req, memberId))) {
      return res.status(403).json({ error: "Vous ne pouvez pas partager ce dossier" });
    }
    const duration = req.body.duration || "2h";
    if (!DOCTOR_SHARE_DURATIONS[duration]) return res.status(400).json({ error: "Durée invalide (2h, 24h ou 7j)" });

    const includeEssentials = req.body.includeEssentials !== false;
    const includeTreatments = Boolean(req.body.includeTreatments);
    const includeVaccinations = Boolean(req.body.includeVaccinations);
    const documentIds = [...new Set((req.body.documentIds ?? []).map((id) => parseInt(id)).filter((id) => !isNaN(id)))];
    if (documentIds.length > 0) {
      const docs = await db.select().from(documents).where(inArray(documents.id, documentIds));
      const valid = docs.filter((d) => d.memberId === memberId && canSeeDocument(req, d));
      if (valid.length !== documentIds.length) return res.status(400).json({ error: "Document invalide pour ce dossier" });
    }
    if (!includeEssentials && !includeTreatments && !includeVaccinations && documentIds.length === 0) {
      return res.status(400).json({ error: "Choisissez au moins un élément à partager" });
    }

    const token = newToken();
    const [share] = await db
      .insert(doctorShares)
      .values({
        memberId,
        familyId: req.familyId,
        createdByUserId: req.user.id,
        tokenHash: hashToken(token),
        includeEssentials,
        includeTreatments,
        includeVaccinations,
        documentIds,
        expiresAt: new Date(Date.now() + DOCTOR_SHARE_DURATIONS[duration]),
      })
      .returning();

    const [member] = await db.select().from(members).where(eq(members.id, memberId));
    await notifyShareEvent(share, member, {
      key: "created",
      title: `Lien médecin créé pour ${member.firstName}`,
      body: `${req.user.name} a créé un lien de consultation valable ${DURATION_LABEL[duration]} (jusqu'au ${formatDateTime(share.expiresAt)}). Il ne peut être ouvert qu'une fois, sur un seul appareil.`,
    });

    // Le lien en clair n'est renvoyé qu'ici : seule son empreinte est conservée.
    res.status(201).json({ ...present(share, req.user.name), url: `${frontendUrl()}/medecin/${token}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post(
  "/:id/revoke",
  requireFamilyMembership((req) => familyIdFromResource(doctorShares, req.params.id)),
  async (req, res) => {
    try {
      const [share] = await db.select().from(doctorShares).where(eq(doctorShares.id, parseInt(req.params.id)));
      if (!share) return res.status(404).json({ error: "Partage introuvable" });
      if (!(await canManageShares(req, share.memberId))) return res.status(403).json({ error: "Accès refusé" });
      if (share.revokedAt) return res.json(present(share));
      const [revoked] = await db
        .update(doctorShares)
        .set({ revokedAt: new Date(), sessionHash: null })
        .where(and(eq(doctorShares.id, share.id)))
        .returning();
      const [member] = await db.select().from(members).where(eq(members.id, share.memberId));
      await notifyShareEvent(share, member, {
        key: "revoked",
        title: `Lien médecin révoqué pour ${member.firstName}`,
        body: `${req.user.name} a révoqué le lien de consultation créé le ${formatDateTime(share.createdAt)}.`,
      });
      res.json(present(revoked));
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;
