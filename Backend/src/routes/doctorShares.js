import { Router } from "express";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { doctorShares, documents, members, users } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdFromMemberId, familyIdFromResource } from "../lib/familyResolvers.js";
import { canSeeDocument, canWriteMember, isHolder } from "../lib/documentAccess.js";
import { DOCTOR_SHARE_DURATIONS, frontendUrl, hashToken, newToken, recipientsFor, shareState } from "../lib/sharing.js";
import { formatDateTime } from "../lib/time.js";
import { sendDoctorShareEmail } from "../lib/mailer.js";
import { QUOTA_MESSAGE, overDailyQuota } from "../lib/sendQuota.js";
import { notify } from "../reminders/notify.js";
import { logActivity } from "../lib/activityLog.js";

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function present(share, authorName) {
  return {
    id: share.id,
    memberId: share.memberId,
    includeEssentials: share.includeEssentials,
    includeTreatments: share.includeTreatments,
    includeVaccinations: share.includeVaccinations,
    documentIds: share.documentIds,
    doctorEmail: share.doctorEmail ?? null,
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
    // Le lien part par courriel au médecin : la famille ne le voit jamais.
    const doctorEmail = String(req.body.doctorEmail ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(doctorEmail) || doctorEmail.length > 255) {
      return res.status(400).json({ error: "Adresse courriel du médecin invalide" });
    }
    if (await overDailyQuota(doctorShares, doctorShares.createdByUserId, req.user.id)) {
      return res.status(429).json({ error: QUOTA_MESSAGE });
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
      // Un document confidentiel ne quitte la famille que par la décision de
      // son titulaire : l'Administrateur A1, qui peut le voir, ne peut pas
      // l'envoyer à un médecin.
      if (valid.some((d) => d.isConfidential) && !isHolder(req, memberId)) {
        return res.status(403).json({ error: "Seul le titulaire du dossier peut partager un document confidentiel" });
      }
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
        doctorEmail,
        expiresAt: new Date(Date.now() + DOCTOR_SHARE_DURATIONS[duration]),
      })
      .returning();

    const [member] = await db.select().from(members).where(eq(members.id, memberId));
    try {
      await sendDoctorShareEmail({
        to: doctorEmail,
        link: `${frontendUrl()}/medecin/${token}`,
        memberName: `${member.firstName} ${member.lastName}`,
        senderName: req.user.name,
        expiresAtLabel: formatDateTime(share.expiresAt),
      });
    } catch (mailError) {
      // Le lien n'existe que dans ce courriel : sans envoi, il est inutilisable.
      console.error(mailError);
      await db.delete(doctorShares).where(eq(doctorShares.id, share.id));
      return res.status(502).json({ error: "Le courriel n'a pas pu être envoyé au médecin. Vérifiez l'adresse et réessayez." });
    }

    await notifyShareEvent(share, member, {
      key: "created",
      title: `Lien médecin envoyé pour ${member.firstName}`,
      body: `${req.user.name} a envoyé à ${doctorEmail} un lien de consultation valable ${DURATION_LABEL[duration]} (jusqu'au ${formatDateTime(share.expiresAt)}). Il ne peut être ouvert qu'une fois, sur un seul appareil.`,
    });

    await logActivity({
      familyId: req.familyId,
      actor: req.user,
      action: "doctor_share_sent",
      member,
      details: {
        shareId: share.id,
        doctorEmail,
        duration,
        includeEssentials,
        includeTreatments,
        includeVaccinations,
        documentsCount: documentIds.length,
      },
    });

    // Seule l'empreinte du lien est conservée ; il n'est jamais renvoyé ici.
    res.status(201).json(present(share, req.user.name));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Révocation : coupe l'accès du médecin immédiatement, même si le lien a déjà
// été ouvert (§10 : partage temporaire et révocable).
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
        .where(eq(doctorShares.id, share.id))
        .returning();
      const [member] = await db.select().from(members).where(eq(members.id, share.memberId));
      await notifyShareEvent(share, member, {
        key: "revoked",
        title: `Lien médecin révoqué pour ${member.firstName}`,
        body: `${req.user.name} a révoqué le lien envoyé le ${formatDateTime(share.createdAt)}${share.doctorEmail ? ` à ${share.doctorEmail}` : ""}. Le médecin n'a plus accès au dossier.`,
      });
      await logActivity({
        familyId: share.familyId,
        actor: req.user,
        action: "doctor_share_revoked",
        member,
        details: { shareId: share.id, doctorEmail: share.doctorEmail },
      });
      res.json(present(revoked));
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;
