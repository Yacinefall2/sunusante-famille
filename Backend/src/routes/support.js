import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { familyMemberships, supportRequestMessages, supportRequests, users } from "../db/schema.js";
import { normalizeEmail } from "../lib/loginThrottle.js";
import { WindowCounter, ipRateLimit } from "../lib/rateLimit.js";
import { hashToken } from "../lib/session.js";
import { checkPassword } from "../lib/passwordCheck.js";
import {
  CLOSED_STATUSES,
  MAX_DESCRIPTION_LENGTH,
  MAX_MESSAGE_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  REPORT_REASONS,
  cleanText,
  createSupportRequest,
  messagesOf,
  presentForUser,
} from "../lib/supportRequests.js";

// ── Demandes au support, côté utilisateur (UC-50 à 52) ───────────────────────
// Deux routeurs :
//   - supportPublicRouter (/api/support/public) : sans session — « Je n'arrive
//     plus à accéder à mon compte » et lien de confirmation reçu par courriel ;
//   - supportRouter (/api/support) : compte connecté — « Contacter le
//     support », « Signaler un compte », « Mes demandes ».

const DESCRIPTION_ERROR = `Décrivez votre demande (${MIN_DESCRIPTION_LENGTH} à ${MAX_DESCRIPTION_LENGTH} caractères)`;
const GENERIC_RECOVERY_RESPONSE = {
  success: true,
  message:
    "Si un compte existe avec cette adresse, un lien de confirmation vient d'y être envoyé. Le support traitera votre demande une fois l'identité confirmée.",
};

// Limites : par adresse IP (routes publiques) et par adresse visée (au plus
// 3 demandes par heure pour une même adresse, en silence au-delà).
export const SUPPORT_PUBLIC_IP_LIMIT = 10;
const publicIpLimit = ipRateLimit({
  windowMs: 60 * 60 * 1000,
  max: SUPPORT_PUBLIC_IP_LIMIT,
  message: "Trop de demandes depuis votre connexion. Réessayez dans une heure.",
  name: "support-public",
});
const recoveryPerEmail = new WindowCounter({ windowMs: 60 * 60 * 1000, max: 3, lockMs: 60 * 60 * 1000 });
// Compte connecté : au plus 10 demandes ou signalements par heure.
const requestsPerUser = new WindowCounter({ windowMs: 60 * 60 * 1000, max: 10, lockMs: 60 * 60 * 1000 });

export const supportPublicRouter = Router();

// « Je n'arrive plus à accéder à mon compte » (UC-50). Réponse IDENTIQUE que
// l'adresse corresponde à un compte ou non (anti-énumération). Si le compte
// existe, le lien de confirmation part à SON adresse ; si la personne n'a
// plus accès à cette boîte, la demande reste « non vérifiée » et le support
// vérifie l'identité hors application.
supportPublicRouter.post("/access-request", publicIpLimit, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: "Adresse courriel du compte invalide" });
    const description = cleanText(req.body?.description, { min: MIN_DESCRIPTION_LENGTH, max: MAX_DESCRIPTION_LENGTH });
    if (!description) return res.status(400).json({ error: DESCRIPTION_ERROR });
    let newEmail = null;
    if (req.body?.newEmail) {
      newEmail = normalizeEmail(req.body.newEmail);
      if (!newEmail) return res.status(400).json({ error: "Nouvelle adresse de contact invalide" });
      if (newEmail === email) newEmail = null;
    }

    if (recoveryPerEmail.blockedMs(email) > 0) return res.json(GENERIC_RECOVERY_RESPONSE);
    recoveryPerEmail.add(email);

    const [user] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.email, email));
    await createSupportRequest(
      {
        type: "recovery",
        status: "unverified",
        userId: user?.id ?? null,
        accountEmail: email,
        requesterUserId: user?.id ?? null,
        contactEmail: newEmail ?? email,
        newEmail,
        description,
      },
      { verify: user ?? null }
    );
    res.json(GENERIC_RECOVERY_RESPONSE);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Lien de confirmation reçu par courriel : la demande devient « vérifiée »
// (statut open) et part au support.
supportPublicRouter.post("/confirm/:token", publicIpLimit, async (req, res) => {
  try {
    const [request] = await db
      .select()
      .from(supportRequests)
      .where(eq(supportRequests.verificationTokenHash, hashToken(String(req.params.token))));
    if (!request) return res.status(404).json({ error: "Lien de confirmation invalide" });
    if (request.verifiedAt) return res.status(409).json({ error: "Cette demande a déjà été confirmée", reference: request.reference });
    if (!request.verificationExpiresAt || request.verificationExpiresAt < new Date()) {
      return res.status(410).json({ error: "Ce lien a expiré : faites une nouvelle demande" });
    }
    const now = new Date();
    const [confirmed] = await db
      .update(supportRequests)
      .set({ verifiedAt: now, status: request.status === "unverified" ? "open" : request.status, updatedAt: now })
      .where(and(eq(supportRequests.id, request.id), isNull(supportRequests.verifiedAt)))
      .returning();
    if (!confirmed) return res.status(409).json({ error: "Cette demande a déjà été confirmée", reference: request.reference });
    res.json({ reference: confirmed.reference, type: confirmed.type, status: confirmed.status });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export const supportRouter = Router();

function tooManyRequests(req, res) {
  if (requestsPerUser.blockedMs(String(req.user.id)) > 0) {
    res.status(429).json({ error: "Trop de demandes envoyées. Réessayez dans une heure." });
    return true;
  }
  requestsPerUser.add(String(req.user.id));
  return false;
}

// « Mes demandes » : celles dont on est l'auteur. Un signalement visant le
// compte n'y apparaît jamais (le compte signalé n'est pas prévenu).
supportRouter.get("/requests", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(supportRequests)
      .where(eq(supportRequests.requesterUserId, req.user.id))
      .orderBy(desc(supportRequests.createdAt), desc(supportRequests.id));
    const messages = await messagesOf(rows.map((r) => r.id));
    res.json(rows.map((r) => presentForUser(r, messages)));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// « Contacter le support » : suppression de mes données (UC-51) ou autre
// question. Pour une suppression — « demande écrite et identité confirmée » —
// le mot de passe est redemandé ET un lien de confirmation part à l'adresse
// du compte.
supportRouter.post("/requests", async (req, res) => {
  try {
    const type = req.body?.type;
    if (!["data_deletion", "other"].includes(type)) return res.status(400).json({ error: "Type de demande invalide" });
    const description = cleanText(req.body?.description, { min: MIN_DESCRIPTION_LENGTH, max: MAX_DESCRIPTION_LENGTH });
    if (!description) return res.status(400).json({ error: DESCRIPTION_ERROR });

    let user = req.user;
    if (type === "data_deletion") {
      user = await checkPassword(req, res);
      if (!user) return;
    }
    if (tooManyRequests(req, res)) return;

    const { request } = await createSupportRequest(
      {
        type,
        userId: user.id,
        accountEmail: user.email,
        requesterUserId: user.id,
        contactEmail: user.email,
        description,
        deleteMedicalRecord: type === "data_deletion" && req.body?.deleteMedicalRecord === true,
      },
      { verify: type === "data_deletion" ? { email: user.email, name: user.name } : null }
    );
    res.status(201).json({ ...presentForUser(request, []), confirmationSent: type === "data_deletion" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// « Signaler un compte » (UC-52) : un compte de SA famille, jamais soi-même.
// Le compte signalé n'est pas prévenu à ce stade.
supportRouter.post("/reports", async (req, res) => {
  try {
    const familyId = Number(req.body?.familyId);
    const targetUserId = Number(req.body?.targetUserId);
    const reason = req.body?.reason;
    if (!Number.isInteger(familyId) || !Number.isInteger(targetUserId)) return res.status(400).json({ error: "Compte à signaler invalide" });
    if (!REPORT_REASONS[reason]) return res.status(400).json({ error: "Motif invalide" });
    const description = cleanText(req.body?.description, { min: MIN_DESCRIPTION_LENGTH, max: MAX_DESCRIPTION_LENGTH });
    if (!description) return res.status(400).json({ error: DESCRIPTION_ERROR });
    if (targetUserId === req.user.id) return res.status(400).json({ error: "Vous ne pouvez pas signaler votre propre compte" });

    const memberships = await db
      .select({ userId: familyMemberships.userId })
      .from(familyMemberships)
      .where(eq(familyMemberships.familyId, familyId));
    const ids = memberships.map((m) => m.userId);
    if (!ids.includes(req.user.id)) return res.status(403).json({ error: "Accès refusé à cette famille" });
    if (!ids.includes(targetUserId)) return res.status(404).json({ error: "Ce compte ne fait pas partie de votre famille" });
    if (tooManyRequests(req, res)) return;

    const [target] = await db.select({ email: users.email }).from(users).where(eq(users.id, targetUserId));
    const { request } = await createSupportRequest({
      type: "report",
      status: "open",
      userId: targetUserId,
      accountEmail: target?.email ?? null,
      requesterUserId: req.user.id,
      contactEmail: req.user.email,
      familyId,
      reportReason: reason,
      description,
    });
    res.status(201).json(presentForUser(request, []));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Répondre au support sur une de ses demandes (tant qu'elle n'est pas close).
supportRouter.post("/requests/:id/messages", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [request] = Number.isInteger(id) ? await db.select().from(supportRequests).where(eq(supportRequests.id, id)) : [];
    if (!request || request.requesterUserId !== req.user.id) return res.status(404).json({ error: "Demande introuvable" });
    if (CLOSED_STATUSES.includes(request.status)) return res.status(409).json({ error: "Cette demande est close : faites-en une nouvelle si besoin" });
    const body = cleanText(req.body?.body, { max: MAX_MESSAGE_LENGTH });
    if (!body) return res.status(400).json({ error: `Message requis (${MAX_MESSAGE_LENGTH} caractères maximum)` });
    const now = new Date();
    await db.insert(supportRequestMessages).values({ requestId: request.id, authorType: "user", userId: req.user.id, authorName: req.user.name, body, createdAt: now });
    const [updated] = await db.update(supportRequests).set({ updatedAt: now }).where(eq(supportRequests.id, request.id)).returning();
    res.status(201).json(presentForUser(updated, await messagesOf([request.id])));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});
