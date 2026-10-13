import { db } from "../db/index.js";
import { notifications } from "../db/schema.js";
import { DELIVERY_FAILURE, getPreference } from "../lib/notificationPreferences.js";
import { PUSH_CATEGORIES } from "../lib/push.js";

// Crée une notification selon les préférences du destinataire (UC-65).
// Rien n'est créé si les deux canaux sont coupés ; aucun doublon possible.
// Les rappels (PUSH_CATEGORIES) affichés dans l'application partent aussi en
// notification push vers les appareils abonnés du destinataire, au prochain
// passage du moteur (lib/push.js, dispatchPushes).
export async function notify({ user, category, dedupeKey, title, body, link, familyId, memberId, intakeId, now }) {
  const forced = category === DELIVERY_FAILURE;
  const pref = forced ? { inApp: true, email: false } : await getPreference(user.id, category);
  if (!pref.inApp && !pref.email) return null;
  const [row] = await db
    .insert(notifications)
    .values({
      userId: user.id,
      familyId,
      memberId,
      category,
      dedupeKey,
      title,
      body,
      link,
      intakeId,
      inApp: pref.inApp,
      emailStatus: pref.email && user.emailVerified ? "pending" : "skipped",
      emailNextAttemptAt: now,
      pushStatus: pref.inApp && PUSH_CATEGORIES.has(category) ? "pending" : "skipped",
      createdAt: now,
    })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning();
  return row ?? null;
}

