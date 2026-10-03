import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { notificationPreferences } from "../db/schema.js";

// Catégories réglables par chaque membre (UC-65) et leurs canaux par défaut.
// Les prises de médicament ne partent pas par courriel par défaut (jusqu'à
// plusieurs rappels par jour) ; le courriel reste activable.
export const NOTIFICATION_CATEGORIES = {
  appointment_reminder: { label: "Rappels de rendez-vous (J-3 et J-1)", inApp: true, email: true },
  medication_intake: { label: "Rappels de prise de médicament", inApp: true, email: false },
  vaccine_reminder: { label: "Rappels de vaccin (7 jours avant)", inApp: true, email: true },
};

// Échec de remise d'un courriel : jamais silencieux (§7.3), donc toujours
// affiché dans l'application, sans réglage possible.
export const DELIVERY_FAILURE = "delivery_failure";

export async function getPreference(userId, category) {
  const defaults = NOTIFICATION_CATEGORIES[category];
  if (!defaults) return { inApp: true, email: false };
  const [row] = await db
    .select()
    .from(notificationPreferences)
    .where(and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.category, category)));
  return row ? { inApp: row.inApp, email: row.email } : { inApp: defaults.inApp, email: defaults.email };
}

export async function getAllPreferences(userId) {
  const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  const byCategory = new Map(rows.map((r) => [r.category, r]));
  return Object.entries(NOTIFICATION_CATEGORIES).map(([category, d]) => {
    const row = byCategory.get(category);
    return { category, label: d.label, inApp: row ? row.inApp : d.inApp, email: row ? row.email : d.email };
  });
}

export async function setPreference(userId, category, { inApp, email }) {
  await db
    .insert(notificationPreferences)
    .values({ userId, category, inApp, email })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.category],
      set: { inApp, email },
    });
}
