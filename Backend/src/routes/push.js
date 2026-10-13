import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { pushSubscriptions } from "../db/schema.js";
import { NEUTRAL_BODY, NEUTRAL_TITLE, deviceLabel, pushConfig, sendToSubscription } from "../lib/push.js";
import { INVALID_ID, parseId } from "../lib/validation.js";

// Abonnement de l'appareil aux notifications push (page Notifications,
// section « Cet appareil »). Chaque compte ne voit et ne retire que ses
// propres appareils.
const router = Router();

// Champs renvoyés à l'interface (« Mes appareils »). L'adresse d'abonnement
// (endpoint) sert à reconnaître « cet appareil » dans la liste.
const publicFields = {
  id: pushSubscriptions.id,
  endpoint: pushSubscriptions.endpoint,
  label: pushSubscriptions.label,
  hideDetails: pushSubscriptions.hideDetails,
  createdAt: pushSubscriptions.createdAt,
  lastSuccessAt: pushSubscriptions.lastSuccessAt,
  failures: pushSubscriptions.failures,
};

const BASE64URL = /^[A-Za-z0-9_-]+=*$/;

// Abonnement envoyé par le navigateur (PushSubscription.toJSON()).
function parseSubscription(body) {
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (typeof endpoint !== "string" || endpoint.length > 1000) return null;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  // Les services push des navigateurs sont tous en HTTPS.
  if (url.protocol !== "https:") return null;
  if (typeof p256dh !== "string" || !BASE64URL.test(p256dh) || p256dh.length < 40 || p256dh.length > 200) return null;
  if (typeof auth !== "string" || !BASE64URL.test(auth) || auth.length < 8 || auth.length > 100) return null;
  return { endpoint, p256dh, auth };
}

// Clé publique VAPID (à transmettre au navigateur pour s'abonner). `enabled`
// faux : le serveur n'a pas de clés, l'interface l'explique.
router.get("/public-key", (req, res) => {
  const config = pushConfig();
  res.json({ enabled: !!config, publicKey: config?.publicKey ?? null });
});

router.get("/subscriptions", async (req, res) => {
  try {
    const rows = await db
      .select(publicFields)
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, req.user.id))
      .orderBy(desc(pushSubscriptions.createdAt));
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Abonne CET appareil. Un même navigateur réabonné (nouvelles clés, autre
// compte sur le même appareil) remplace sa ligne : un appareil ne reçoit
// jamais les rappels de deux comptes.
router.post("/subscriptions", async (req, res) => {
  try {
    if (!pushConfig()) {
      return res.status(503).json({ error: "Les notifications push ne sont pas activées sur ce serveur" });
    }
    const sub = parseSubscription(req.body);
    if (!sub) return res.status(400).json({ error: "Abonnement invalide" });
    const userAgent = String(req.get("user-agent") || "").slice(0, 500);
    const hideDetails = req.body?.hideDetails === true;
    const [row] = await db
      .insert(pushSubscriptions)
      .values({ userId: req.user.id, ...sub, userAgent, label: deviceLabel(userAgent), hideDetails })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId: req.user.id,
          p256dh: sub.p256dh,
          auth: sub.auth,
          userAgent,
          label: deviceLabel(userAgent),
          hideDetails,
          failures: 0,
          lastError: null,
          createdAt: new Date(),
        },
      })
      .returning(publicFields);
    res.status(201).json(row);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Option de l'appareil : « Masquer le détail sur l'écran verrouillé ».
router.put("/subscriptions/:id", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: INVALID_ID });
    if (typeof req.body?.hideDetails !== "boolean") return res.status(400).json({ error: "Réglage invalide" });
    const [row] = await db
      .update(pushSubscriptions)
      .set({ hideDetails: req.body.hideDetails })
      .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, req.user.id)))
      .returning(publicFields);
    if (!row) return res.status(404).json({ error: "Appareil introuvable" });
    res.json(row);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Désabonne CET appareil (adresse d'abonnement dans le corps) — appelé à la
// déconnexion et par « Ne plus recevoir les rappels sur cet appareil ».
router.delete("/subscriptions", async (req, res) => {
  try {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== "string" || endpoint.length > 1000) return res.status(400).json({ error: "Abonnement invalide" });
    await db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, req.user.id)));
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// « Retirer » un appareil de la liste « Mes appareils ».
router.delete("/subscriptions/:id", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: INVALID_ID });
    const [row] = await db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, req.user.id)))
      .returning({ id: pushSubscriptions.id });
    if (!row) return res.status(404).json({ error: "Appareil introuvable" });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// « Envoyer une notification de test » à cet appareil (adresse d'abonnement
// dans le corps), en respectant son option « Masquer le détail ».
router.post("/test", async (req, res) => {
  try {
    if (!pushConfig()) {
      return res.status(503).json({ error: "Les notifications push ne sont pas activées sur ce serveur" });
    }
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== "string") return res.status(400).json({ error: "Abonnement invalide" });
    const [sub] = await db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, req.user.id)));
    if (!sub) return res.status(404).json({ error: "Cet appareil n'est pas abonné aux rappels" });
    const ok = await sendToSubscription(sub, {
      title: sub.hideDetails ? NEUTRAL_TITLE : "Notification de test",
      body: sub.hideDetails ? NEUTRAL_BODY : "Les rappels de SunuSanté Famille arriveront ainsi sur cet appareil.",
      tag: `test-${sub.id}`,
      url: "/notifications",
      category: "test",
      notificationId: null,
      intakeId: null,
      actionToken: null,
      timestamp: Date.now(),
    });
    if (!ok) return res.status(502).json({ error: "Le service de notification de l'appareil a refusé l'envoi : réabonnez cet appareil" });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
