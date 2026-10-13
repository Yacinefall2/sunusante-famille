import crypto from "node:crypto";
import webpush from "web-push";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { intakeActionTokens, medicationIntakes, notifications, pushSubscriptions, users } from "../db/schema.js";
import { hashToken } from "./session.js";

// ── Notifications push (Web Push standard, VAPID — aucun service payant) ─────
// Les rappels arrivent sur le téléphone ou l'ordinateur même quand
// SunuSanté Famille est fermée : le navigateur s'abonne auprès de SON service
// push (Google, Mozilla, Apple…), le serveur y dépose un message chiffré de
// bout en bout (seul l'appareil abonné peut le lire), le service worker de
// l'application l'affiche (Frontend/public/sw.js).
//
// Clés VAPID : identifient ce serveur auprès des services push. Générer une
// fois pour toutes : `npx web-push generate-vapid-keys` (dans Backend/), puis
// renseigner VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY et VAPID_SUBJECT
// (mailto:adresse de contact). Sans elles : push désactivé, avec un simple
// avertissement — tout le reste fonctionne (cloche, courriels).

// Catégories qui partent aussi en push quand la notification est affichée
// dans l'application (préférence « Dans l'application » de la catégorie).
export const PUSH_CATEGORIES = new Set([
  "medication_intake",
  "appointment_reminder",
  "vaccine_reminder",
  "relay_to_relay",
  "relay_escalation",
  "relay_alert",
  "role_transfer",
]);

// Titre neutre de l'option « Masquer le détail sur l'écran verrouillé ».
export const NEUTRAL_TITLE = "Rappel SunuSanté Famille";
export const NEUTRAL_BODY = "Ouvrez l'application pour voir le détail.";

// Durée de validité du jeton des boutons « Pris » / « Pas pris ».
export const ACTION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
// Au-delà, un push en attente n'est plus envoyé (worker arrêté longtemps) :
// un rappel de prise de la veille n'a plus de sens sur l'écran verrouillé.
export const PUSH_MAX_AGE_MS = 12 * 60 * 60 * 1000;
// Durée de conservation du message par le service push si l'appareil est
// hors réseau : le rappel arrive au retour du réseau, dans cette limite.
export const PUSH_TTL_SECONDS = 12 * 60 * 60;
// Échecs consécutifs (hors 404/410) au-delà desquels l'abonnement est retiré.
export const PUSH_MAX_FAILURES = 10;

let cachedConfig;
let cachedKey = null;
let warned = false;

// Configuration VAPID lue dans l'environnement (relue si elle change : tests).
// Renvoie null si le push est désactivé.
export function pushConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() || "";
  const subject = process.env.VAPID_SUBJECT?.trim() || "";
  const key = `${publicKey}|${privateKey}|${subject}`;
  if (key === cachedKey) return cachedConfig;
  cachedKey = key;
  cachedConfig = null;
  if (!publicKey || !privateKey || !subject) {
    if (!warned && !process.env.VITEST) {
      warned = true;
      console.warn(
        "⚠️  Notifications push désactivées : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY et VAPID_SUBJECT absentes " +
          "(générer les clés : npx web-push generate-vapid-keys — voir .env.example)."
      );
    }
    return null;
  }
  try {
    // Vérifie le format des clés et du sujet (lève une erreur sinon).
    webpush.setVapidDetails(subject, publicKey, privateKey);
    cachedConfig = { publicKey, privateKey, subject };
  } catch (error) {
    if (!process.env.VITEST) console.warn(`⚠️  Notifications push désactivées : clés VAPID invalides (${error.message}).`);
  }
  return cachedConfig;
}

export const pushEnabled = () => pushConfig() !== null;

// « Chrome sur Android », « Safari sur iPhone »… (liste « Mes appareils »).
export function deviceLabel(userAgent = "") {
  const ua = String(userAgent);
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "Navigateur";
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone/.test(ua)
      ? "iPhone"
      : /iPad/.test(ua)
        ? "iPad"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "Mac"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  return os ? `${browser} sur ${os}` : browser;
}

// Jeton des boutons « Pris » / « Pas pris » d'une notification de prise.
export async function createIntakeActionToken(intakeId, userId, now = new Date()) {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.insert(intakeActionTokens).values({
    tokenHash: hashToken(token),
    intakeId,
    userId,
    expiresAt: new Date(now.getTime() + ACTION_TOKEN_TTL_MS),
    createdAt: now,
  });
  return token;
}

// Page à ouvrir au clic sur la notification : l'accueil (mode senior : la
// grande liste des médicaments du jour) pour une prise, sinon le lien de la
// notification (rendez-vous, vaccinations, Village…).
function targetUrl(n, user) {
  if (n.category === "medication_intake" && user.seniorMode) return "/dashboard";
  return n.link || "/dashboard";
}

// Contenu du push pour un appareil. Avec « Masquer le détail », titre et
// texte neutres, et pas de boutons Pris / Pas pris (la personne ne saurait pas
// à quoi elle répond) : un appui ouvre l'application.
// « Tag » d'une prise : médicament + heure prévue. L'application ouverte
// utilise le même pour ses alertes locales (Frontend/src/lib/seniorAlerts.js) :
// une prise = une seule notification à l'écran.
export const intakeTag = (medicationId, scheduledAt) => `prise-${medicationId}-${new Date(scheduledAt).getTime()}`;

export function buildPayload({ notification: n, user, subscription, intake: prise = null, actionToken = null }) {
  const hidden = subscription.hideDetails;
  const intake = n.category === "medication_intake" && n.intakeId && !hidden;
  return {
    title: hidden ? NEUTRAL_TITLE : n.title,
    body: hidden ? NEUTRAL_BODY : n.body || "",
    tag: prise ? intakeTag(prise.medicationId, prise.scheduledAt) : `notification-${n.id}`,
    url: targetUrl(n, user),
    notificationId: n.id,
    category: n.category,
    intakeId: intake ? n.intakeId : null,
    actionToken: intake ? actionToken : null,
    timestamp: new Date(n.createdAt).getTime(),
  };
}

// Envoi à un appareil. Abonnement expiré (404/410) : supprimé. Autre échec :
// compté ; retiré après PUSH_MAX_FAILURES échecs consécutifs.
// Renvoie true si le service push a accepté le message.
export async function sendToSubscription(subscription, payload, now = new Date()) {
  const config = pushConfig();
  if (!config) return false;
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
        TTL: PUSH_TTL_SECONDS,
        urgency: payload.category === "medication_intake" ? "high" : "normal",
        // Une seule notification par prise si le service la garde (hors réseau)
        topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
      }
    );
    await db
      .update(pushSubscriptions)
      .set({ lastSuccessAt: now, failures: 0, lastError: null })
      .where(eq(pushSubscriptions.id, subscription.id));
    return true;
  } catch (error) {
    const status = error?.statusCode;
    if (status === 404 || status === 410) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
      return false;
    }
    const failures = subscription.failures + 1;
    if (failures >= PUSH_MAX_FAILURES) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
    } else {
      await db
        .update(pushSubscriptions)
        .set({ failures, lastError: String(error?.body || error?.message || "Erreur d'envoi").slice(0, 300) })
        .where(eq(pushSubscriptions.id, subscription.id));
    }
    return false;
  }
}

// ── Envoi des push en attente (appelé à chaque passage du moteur de rappels) ──
export async function dispatchPushes(now = new Date()) {
  const due = await db
    .select({
      n: notifications,
      user: { id: users.id, seniorMode: users.seniorMode },
      intake: { status: medicationIntakes.status, medicationId: medicationIntakes.medicationId, scheduledAt: medicationIntakes.scheduledAt },
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .leftJoin(medicationIntakes, eq(medicationIntakes.id, notifications.intakeId))
    .where(eq(notifications.pushStatus, "pending"))
    .orderBy(notifications.id)
    .limit(200);
  if (due.length === 0) return;

  const skip = async (ids) => {
    if (ids.length > 0) await db.update(notifications).set({ pushStatus: "skipped" }).where(inArray(notifications.id, ids));
  };

  // Push désactivé (pas de clés VAPID) : rien à envoyer, rien d'accumulé.
  if (!pushEnabled()) return skip(due.map((d) => d.n.id));

  for (const { n, user, intake } of due) {
    const tooOld = now.getTime() - new Date(n.createdAt).getTime() > PUSH_MAX_AGE_MS;
    // Prise déjà répondue (ou passée « sans réponse ») avant l'envoi : inutile.
    const answered = n.intakeId && intake?.status && intake.status !== "pending";
    const subscriptions = tooOld || answered ? [] : await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, n.userId));
    if (subscriptions.length === 0) {
      await skip([n.id]);
      continue;
    }
    // Un jeton par notification de prise, commun aux appareils du compte :
    // le premier appui l'utilise, les autres appareils sont alors refusés
    // (la prise est déjà répondue).
    const needsToken = n.category === "medication_intake" && n.intakeId && subscriptions.some((s) => !s.hideDetails);
    const actionToken = needsToken ? await createIntakeActionToken(n.intakeId, n.userId, now) : null;
    let delivered = false;
    for (const subscription of subscriptions) {
      const payload = buildPayload({ notification: n, user, subscription, intake: n.intakeId ? intake : null, actionToken });
      if (await sendToSubscription(subscription, payload, now)) delivered = true;
    }
    await db
      .update(notifications)
      .set({ pushStatus: delivered ? "sent" : "failed", pushSentAt: delivered ? now : null })
      .where(eq(notifications.id, n.id));
  }
}

// Ménage : jetons d'action expirés ou utilisés depuis plus de 24 h.
export async function purgeIntakeActionTokens(now = new Date()) {
  await db
    .delete(intakeActionTokens)
    .where(
      or(
        lte(intakeActionTokens.expiresAt, now),
        and(isNotNull(intakeActionTokens.usedAt), lte(intakeActionTokens.usedAt, new Date(now.getTime() - ACTION_TOKEN_TTL_MS)))
      )
    );
}

// Vérifie et CONSOMME un jeton d'action pour cette prise. Renvoie l'id du
// compte, ou null (jeton inconnu, d'une autre prise, expiré ou déjà utilisé).
// La consommation est atomique : deux appuis simultanés, un seul passe.
export async function consumeIntakeActionToken(token, intakeId, now = new Date()) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const [row] = await db
    .update(intakeActionTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(intakeActionTokens.tokenHash, hashToken(token)),
        eq(intakeActionTokens.intakeId, intakeId),
        isNull(intakeActionTokens.usedAt),
        gt(intakeActionTokens.expiresAt, now)
      )
    )
    .returning({ userId: intakeActionTokens.userId });
  return row?.userId ?? null;
}
