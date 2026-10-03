import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifications } from "../db/schema.js";
import { markEmailFailed } from "../reminders/engine.js";

// Rebonds signalés par le service d'envoi (UC-67) — prêt pour Brevo : son
// webhook « transactionnel » envoie { event, "message-id", reason }. L'adresse
// contient un secret (MAIL_WEBHOOK_SECRET) ; sans lui, la route n'existe pas.
// Utilisable seulement une fois l'application joignable depuis Internet.
const router = Router();

const FAILURE_EVENTS = {
  hard_bounce: "Adresse inexistante ou refusée",
  soft_bounce: "Boîte pleine ou temporairement indisponible",
  blocked: "Envoi bloqué par le service",
  invalid_email: "Adresse invalide",
  spam: "Signalé comme indésirable",
};

router.post("/:secret", async (req, res) => {
  const secret = process.env.MAIL_WEBHOOK_SECRET;
  if (!secret || req.params.secret !== secret) return res.status(404).end();
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
});

export default router;
