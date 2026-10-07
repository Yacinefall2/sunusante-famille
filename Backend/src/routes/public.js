import { Router } from "express";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { doctorShares, documents, emergencyCards, emergencyCardViews, members } from "../db/schema.js";
import { UPLOAD_DIR_PATH } from "../middleware/upload.js";
import { doctorSynthesis, emergencyPublicView, hashToken, newToken, recipientsFor } from "../lib/sharing.js";
import { formatDateTime } from "../lib/time.js";
import { notify } from "../reminders/notify.js";
import { notifyShareEvent } from "./doctorShares.js";

// Routes publiques, sans compte : lien médecin et fiche d'urgence. Aucune
// autre donnée n'est accessible par ici.
const router = Router();

const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const sessionCookie = (shareId) => `sf_medecin_${shareId}`;

// Lien médecin à usage unique (décision phase F) : la première ouverture
// lie le lien à cet appareil (cookie de session) jusqu'à l'expiration ;
// toute ouverture depuis un autre appareil est refusée et signalée.
async function openShare(req, res) {
  const [share] = await db.select().from(doctorShares).where(eq(doctorShares.tokenHash, hashToken(req.params.token)));
  if (!share) {
    res.status(404).json({ error: "Lien inconnu", reason: "unknown" });
    return null;
  }
  const now = new Date();
  if (share.revokedAt) {
    res.status(410).json({ error: "Ce lien a été révoqué par la famille", reason: "revoked" });
    return null;
  }
  if (share.expiresAt <= now) {
    res.status(410).json({ error: "Ce lien a expiré", reason: "expired" });
    return null;
  }
  const [member] = await db.select().from(members).where(eq(members.id, share.memberId));
  const cookie = req.cookies?.[sessionCookie(share.id)];
  if (share.consumedAt) {
    if (cookie && share.sessionHash && hashToken(cookie) === share.sessionHash) return share;
    // Dédoublonnage par heure : plusieurs tentatives rapprochées = un seul avis.
    await notifyShareEvent(share, member, {
      key: `refused:${Math.floor(now.getTime() / 3600e3)}`,
      title: `Ouverture refusée du lien médecin de ${member.firstName}`,
      body: `Quelqu'un a tenté d'ouvrir depuis un autre appareil le lien déjà ouvert le ${formatDateTime(share.consumedAt)}. Si ce n'est pas le médecin, révoquez le lien.`,
    });
    res.status(410).json({ error: "Ce lien a déjà été ouvert sur un autre appareil", reason: "already_opened" });
    return null;
  }

  const session = newToken();
  // Mise à jour conditionnelle : deux ouvertures simultanées, une seule gagne.
  const [claimed] = await db
    .update(doctorShares)
    .set({ consumedAt: now, sessionHash: hashToken(session) })
    .where(and(eq(doctorShares.id, share.id), isNull(doctorShares.consumedAt)))
    .returning();
  if (!claimed) {
    res.status(410).json({ error: "Ce lien a déjà été ouvert sur un autre appareil", reason: "already_opened" });
    return null;
  }
  res.cookie(sessionCookie(share.id), session, {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    path: "/api/public/doctor",
    expires: share.expiresAt,
  });
  await notifyShareEvent(share, member, {
    key: "opened",
    title: `Le lien médecin de ${member.firstName} a été ouvert`,
    body: `Le dossier partagé a été consulté le ${formatDateTime(now)}. Le lien reste lisible sur cet appareil jusqu'au ${formatDateTime(share.expiresAt)}.`,
  });
  return claimed;
}

router.get("/doctor/:token", async (req, res) => {
  try {
    const share = await openShare(req, res);
    if (!share) return;
    await db.update(doctorShares).set({ lastViewedAt: new Date() }).where(eq(doctorShares.id, share.id));
    res.set("Cache-Control", "no-store");
    res.json(await doctorSynthesis(share));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Fichier d'un document explicitement partagé, sur l'appareil déjà autorisé.
router.get("/doctor/:token/documents/:documentId", async (req, res) => {
  try {
    const [share] = await db.select().from(doctorShares).where(eq(doctorShares.tokenHash, hashToken(req.params.token)));
    const cookie = share && req.cookies?.[sessionCookie(share.id)];
    const valid =
      share && !share.revokedAt && share.expiresAt > new Date() && cookie && share.sessionHash === hashToken(cookie);
    if (!valid) return res.status(403).json({ error: "Accès refusé" });
    const documentId = parseInt(req.params.documentId);
    if (!share.documentIds.includes(documentId)) return res.status(403).json({ error: "Document non partagé" });
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    if (!doc?.fileUrl || doc.memberId !== share.memberId) return res.status(404).json({ error: "Fichier introuvable" });
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(UPLOAD_DIR_PATH, path.basename(doc.fileUrl)), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Fichier introuvable" });
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Fiche d'urgence (UC-48/49) : seulement les champs cochés. Chaque
// consultation est enregistrée et le titulaire est prévenu.
router.get("/emergency/:token", async (req, res) => {
  try {
    const [card] = await db.select().from(emergencyCards).where(eq(emergencyCards.token, req.params.token));
    if (!card || !card.active) return res.status(404).json({ error: "Fiche d'urgence introuvable ou désactivée" });
    const [member] = await db.select().from(members).where(eq(members.id, card.memberId));
    const [view] = await db.insert(emergencyCardViews).values({ cardId: card.id }).returning();
    const now = view.viewedAt;
    // Un avis par quart d'heure au plus : rafraîchir la page n'inonde pas le titulaire.
    const bucket = Math.floor(now.getTime() / (15 * 60e3));
    for (const user of await recipientsFor(member)) {
      await notify({
        user,
        category: "emergency_view",
        dedupeKey: `emergency:${card.id}:${bucket}:${user.id}`,
        title: `Fiche d'urgence de ${member.firstName} consultée`,
        body: `La fiche d'urgence a été ouverte le ${formatDateTime(now)} (QR code ou lien). Si cela vous surprend, régénérez le QR code.`,
        link: `/partage?fiche=${member.id}`,
        familyId: member.familyId,
        memberId: member.id,
        now,
      });
    }
    res.set("Cache-Control", "no-store");
    res.json(await emergencyPublicView(card, member));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
