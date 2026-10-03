import { db } from "../db/index.js";
import { notifications } from "../db/schema.js";
import { DELIVERY_FAILURE, getPreference } from "../lib/notificationPreferences.js";

// Crée une notification selon les préférences du destinataire (UC-65).
// Rien n'est créé si les deux canaux sont coupés ; aucun doublon possible.
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
      createdAt: now,
    })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning();
  return row ?? null;
}

