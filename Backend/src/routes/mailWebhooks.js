import crypto from "node:crypto";
import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifications } from "../db/schema.js";
import { markEmailFailed } from "../reminders/engine.js";

// Rebonds signalés par le service d'envoi (UC-67) — prêt pour Brevo : son
// webhook « transactionnel » envoie { event, "message-id", reason }. Le secret
// MAIL_WEBHOOK_SECRET est exigé ; sans lui, la route n'existe pas. Deux façons
// de le transmettre :
//   - dans l'en-tête X-Webhook-Secret, adresse POST /api/webhooks/mail
//     (préférable : un en-tête n'apparaît pas dans les journaux d'accès des
//     serveurs et proxys, contrairement à l'adresse) ;
//   - dans l'adresse, POST /api/webhooks/mail/<secret> (pour les services qui
//     ne savent pas ajouter d'en-tête).
// Utilisable seulement une fois l'application joignable depuis Internet.
const router = Router();

const FAILURE_EVENTS = {
  hard_bounce: "Adresse inexistante ou refusée",
  soft_bounce: "Boîte pleine ou temporairement indisponible",
  blocked: "Envoi bloqué par le service",
  invalid_email: "Adresse invalide",
  spam: "Signalé comme indésirable",
};

// Comparaison à durée constante : le temps de réponse ne trahit pas le secret.
function sameSecret(given, expected) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function handleEvents(req, res, given) {
  const secret = process.env.MAIL_WEBHOOK_SECRET;
  if (!secret || given == null || !sameSecret(given, secret)) return res.status(404).end();
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const event of events) {
      const reason = FAILURE_EVENTS[event?.event];
      const messageId = event?.["message-id"];
      if (!reason || !messageId) continue;
      const [notification] = await db.select().from(notifications).where(eq(notifications.emailMessageId, messageId));
      if (notification && notification.emailStatus !== "failed") {
        await markEmailFailed(notification, event.reason ? `${reason} (${event.reason})` : reason);
      }
    }
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
}

router.post("/", (req, res) => handleEvents(req, res, req.get("x-webhook-secret")));
router.post("/:secret", (req, res) => handleEvents(req, res, req.params.secret));

export default router;
