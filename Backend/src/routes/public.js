import { Router } from "express";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { doctorShares, documents, emergencyCards, emergencyCardViews, members } from "../db/schema.js";
import { sendStoredFile } from "../middleware/upload.js";
import { COOKIE_SECURE } from "../lib/session.js";
import { ipRateLimit } from "../lib/rateLimit.js";
import {
  doctorSynthesis,
  emergencyPublicView,
  hashToken,
  newToken,
  recipientsFor,
  sharedDocumentFilter,
  upgradeEmergencyCard,
} from "../lib/sharing.js";
import { formatDateTime } from "../lib/time.js";
import { notify } from "../reminders/notify.js";
import { notifyShareEvent } from "./doctorShares.js";

// Routes publiques, sans compte : lien médecin et fiche d'urgence. Aucune
// autre donnée n'est accessible par ici.
const router = Router();

// Limite par adresse IP : freine l'essai de jetons en série et les
// consultations en rafale (chaque consultation prévient la famille).
export const PUBLIC_IP_LIMIT = 100;
export const PUBLIC_IP_WINDOW_MS = 15 * 60 * 1000;
router.use(
  ipRateLimit({
    windowMs: PUBLIC_IP_WINDOW_MS,
    max: PUBLIC_IP_LIMIT,
    message: "Trop de requêtes depuis votre connexion. Réessayez dans quelques minutes.",
  })
);

const sessionCookie = (shareId) => `sf_medecin_${shareId}`;

// ── Lien médecin à usage unique (décision phase F) ──────────────────────────
// L'ouverture se fait en deux temps, pour que les robots des messageries
// (analyse des liens, Outlook Safe Links...) qui chargent la page — parfois en
// exécutant son JavaScript — ne « consomment » pas le lien à la place du
// médecin :
//   1. GET  /doctor/:token/status — sans effet : état du lien, prénom du
//      patient, échéance ; aucune donnée médicale ;
//   2. POST /doctor/:token/open   — clic du médecin sur « Ouvrir le dossier » :
//      lie le lien à cet appareil (cookie de session) jusqu'à l'expiration ;
//   3. GET  /doctor/:token        — la synthèse, seulement sur cet appareil.
// Toute ouverture depuis un autre appareil est refusée et signalée.

async function findShare(req) {
  const [share] = await db.select().from(doctorShares).where(eq(doctorShares.tokenHash, hashToken(req.params.token)));
  return share ?? null;
}

// Lien inconnu, révoqué ou expiré : réponse d'erreur envoyée, renvoie true.
function rejectInvalid(share, res, now = new Date()) {
  if (!share) {
    res.status(404).json({ error: "Lien inconnu", reason: "unknown" });
    return true;
  }
  if (share.revokedAt) {
    res.status(410).json({ error: "Ce lien a été révoqué par la famille", reason: "revoked" });
    return true;
  }
  if (share.expiresAt <= now) {
    res.status(410).json({ error: "Ce lien a expiré", reason: "expired" });
    return true;
  }
  return false;
}

// Cet appareil détient-il la session du lien (cookie posé à l'ouverture) ?
function hasDeviceSession(req, share) {
  const cookie = req.cookies?.[sessionCookie(share.id)];
  return Boolean(share.consumedAt && share.sessionHash && cookie && hashToken(cookie) === share.sessionHash);
}

// Tentative d'accès depuis un autre appareil que celui qui a ouvert le lien :
// la famille est prévenue (un avis par heure au plus) et l'accès refusé.
async function refuseOtherDevice(share, res) {
  const now = new Date();
  const [member] = await db.select().from(members).where(eq(members.id, share.memberId));
  await notifyShareEvent(share, member, {
    key: `refused:${Math.floor(now.getTime() / 3600e3)}`,
    title: `Ouverture refusée du lien médecin de ${member.firstName}`,
    body: `Quelqu'un a tenté d'ouvrir depuis un autre appareil le lien déjà ouvert le ${formatDateTime(share.consumedAt)}. L'accès a été bloqué. Si cela vous inquiète, révoquez le lien.`,
  });
  res.status(410).json({ error: "Ce lien a déjà été ouvert sur un autre appareil", reason: "already_opened" });
}

// État du lien, sans le consommer ni rien signaler (les robots passent ici).
router.get("/doctor/:token/status", async (req, res) => {
  try {
    const share = await findShare(req);
    if (rejectInvalid(share, res)) return;
    const hasSession = hasDeviceSession(req, share);
    if (share.consumedAt && !hasSession) {
      return res.status(410).json({ error: "Ce lien a déjà été ouvert sur un autre appareil", reason: "already_opened" });
    }
    const [member] = await db.select({ firstName: members.firstName }).from(members).where(eq(members.id, share.memberId));
    res.json({
      state: share.consumedAt ? "opened" : "pending",
      hasSession,
      memberFirstName: member?.firstName ?? null,
      expiresAt: share.expiresAt,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Ouverture par le médecin (bouton « Ouvrir le dossier ») : consomme le lien
// et lie cet appareil. Sans effet si cet appareil l'a déjà ouvert.
router.post("/doctor/:token/open", async (req, res) => {
  try {
    const share = await findShare(req);
    if (rejectInvalid(share, res)) return;
    if (share.consumedAt) {
      if (hasDeviceSession(req, share)) return res.json({ state: "opened" });
      return refuseOtherDevice(share, res);
    }

    const now = new Date();
    const session = newToken();
    // Mise à jour conditionnelle : deux ouvertures simultanées, une seule gagne.
    const [claimed] = await db
      .update(doctorShares)
      .set({ consumedAt: now, sessionHash: hashToken(session) })
      .where(and(eq(doctorShares.id, share.id), isNull(doctorShares.consumedAt)))
      .returning();
    if (!claimed) {
      return res.status(410).json({ error: "Ce lien a déjà été ouvert sur un autre appareil", reason: "already_opened" });
    }
    res.cookie(sessionCookie(share.id), session, {
      httpOnly: true,
      sameSite: "lax",
      secure: COOKIE_SECURE,
      path: "/api/public/doctor",
      expires: share.expiresAt,
    });
    const [member] = await db.select().from(members).where(eq(members.id, share.memberId));
    await notifyShareEvent(share, member, {
      key: "opened",
      title: `Le lien médecin de ${member.firstName} a été ouvert`,
      body: `Le dossier partagé a été consulté le ${formatDateTime(now)}. Le lien reste lisible sur cet appareil jusqu'au ${formatDateTime(share.expiresAt)}.`,
    });
    res.json({ state: "opened" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Synthèse du dossier : seulement sur l'appareil qui a ouvert le lien.
router.get("/doctor/:token", async (req, res) => {
  try {
    const share = await findShare(req);
    if (rejectInvalid(share, res)) return;
    if (!share.consumedAt) {
      return res.status(403).json({ error: "Ouvrez d'abord le dossier depuis le lien reçu", reason: "not_opened" });
    }
    if (!hasDeviceSession(req, share)) return refuseOtherDevice(share, res);
    await db.update(doctorShares).set({ lastViewedAt: new Date() }).where(eq(doctorShares.id, share.id));
    res.json(await doctorSynthesis(share));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Fichier d'un document explicitement partagé, sur l'appareil déjà autorisé.
router.get("/doctor/:token/documents/:documentId", async (req, res) => {
  try {
    const share = await findShare(req);
    const valid = share && !share.revokedAt && share.expiresAt > new Date() && hasDeviceSession(req, share);
    if (!valid) return res.status(403).json({ error: "Accès refusé" });
    const documentId = parseInt(req.params.documentId);
    if (!share.documentIds.includes(documentId)) return res.status(403).json({ error: "Document non partagé" });
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    if (!doc?.fileUrl || doc.memberId !== share.memberId) return res.status(404).json({ error: "Fichier introuvable" });
    // Document devenu confidentiel alors que le lien n'a pas été créé par le
    // titulaire : plus accessible (même règle que la synthèse).
    const [member] = await db.select().from(members).where(eq(members.id, share.memberId));
    if (!(await sharedDocumentFilter(share, member))(doc)) return res.status(403).json({ error: "Document non partagé" });
    sendStoredFile(res, doc.fileUrl, doc.originalName);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── Fiche d'urgence (UC-48/49) ──────────────────────────────────────────────
// Seulement les champs cochés. Les consultations sont enregistrées (une ligne
// par fiche et par minute au plus : rafraîchir la page ou un robot qui insiste
// ne remplit pas la table) et le titulaire est prévenu.
export const EMERGENCY_VIEW_INTERVAL_MS = 60 * 1000;

router.get("/emergency/:token", async (req, res) => {
  try {
    // Recherche par empreinte : la base ne contient pas le jeton en clair.
    let [card] = await db.select().from(emergencyCards).where(eq(emergencyCards.tokenHash, hashToken(req.params.token)));
    if (!card || !card.active) return res.status(404).json({ error: "Fiche d'urgence introuvable ou désactivée" });
    card = await upgradeEmergencyCard(card);
    const [member] = await db.select().from(members).where(eq(members.id, card.memberId));

    const now = new Date();
    const [recent] = await db
      .select({ id: emergencyCardViews.id })
      .from(emergencyCardViews)
      .where(
        and(
          eq(emergencyCardViews.cardId, card.id),
          gt(emergencyCardViews.viewedAt, new Date(now.getTime() - EMERGENCY_VIEW_INTERVAL_MS))
        )
      )
      .orderBy(desc(emergencyCardViews.viewedAt))
      .limit(1);
    if (!recent) {
      await db.insert(emergencyCardViews).values({ cardId: card.id, viewedAt: now });
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
    }
    res.json(await emergencyPublicView(card, member));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
