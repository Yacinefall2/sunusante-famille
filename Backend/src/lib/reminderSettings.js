import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { familyReminderSettings } from "../db/schema.js";

// ── Règles d'escalade des rappels du Village, par famille (UC-08) ────────────
// Réglables par les parents (A1, A2) dans des bornes fixes. Sans réglage
// enregistré, les valeurs par défaut reproduisent EXACTEMENT le cycle
// d'origine (reminders/village.js) :
//   - premier « à relayer » aux gestionnaires 3 jours avant le rendez-vous ;
//   - relance la veille (24 h avant) ;
//   - escalade vers les relais 3 h après la relance sans « Prévenu » ;
//   - « s'y est-il rendu ? » le soir même — c'est-à-dire 12 h après le
//     rendez-vous, comme à l'origine (un rendez-vous du matin donne une
//     question en soirée). « Le lendemain matin » : le lendemain à 8 h.
// Seul le cycle du Village (proches non connectés) est concerné : les
// rappels classiques J-3 / J-1 des autres fiches restent fixes.

export const ATTENDANCE_PROMPTS = ["same_evening", "next_morning"];
export const NEXT_MORNING_TIME = "08:00";

export const DEFAULT_REMINDER_SETTINGS = Object.freeze({
  relayFirstDays: 3,
  followUpDaysBefore: 1,
  escalationDelayHours: 3,
  attendancePrompt: "same_evening",
});

export const REMINDER_BOUNDS = {
  relayFirstDays: { min: 2, max: 7, label: "Premier « à relayer » (jours avant le rendez-vous)" },
  followUpDaysBefore: { min: 1, max: 2, label: "Relance (jours avant le rendez-vous)" },
  escalationDelayHours: { min: 1, max: 12, label: "Délai avant l'escalade vers les relais (heures)" },
};

const pick = (row) => ({
  relayFirstDays: row.relayFirstDays,
  followUpDaysBefore: row.followUpDaysBefore,
  escalationDelayHours: row.escalationDelayHours,
  attendancePrompt: row.attendancePrompt,
});

// Réglages effectifs d'une famille : { ...valeurs, isDefault, updatedAt, updatedByUserId }.
export async function getReminderSettings(familyId) {
  const [row] = await db.select().from(familyReminderSettings).where(eq(familyReminderSettings.familyId, familyId));
  if (!row) return { ...DEFAULT_REMINDER_SETTINGS, isDefault: true, updatedAt: null, updatedByUserId: null };
  return { ...pick(row), isDefault: false, updatedAt: row.updatedAt, updatedByUserId: row.updatedByUserId };
}

// Valide un corps de requête complet. Renvoie { value } ou { error }.
export function validateReminderSettings(body) {
  const value = {};
  for (const [key, { min, max, label }] of Object.entries(REMINDER_BOUNDS)) {
    const n = body?.[key];
    if (!Number.isInteger(n) || n < min || n > max) return { error: `${label} : nombre entier de ${min} à ${max} attendu` };
    value[key] = n;
  }
  if (!ATTENDANCE_PROMPTS.includes(body?.attendancePrompt)) {
    return { error: "Moment de la question « s'y est-il rendu ? » : « le soir même » ou « le lendemain matin »" };
  }
  value.attendancePrompt = body.attendancePrompt;
  // La relance doit venir après le premier « à relayer ».
  if (value.followUpDaysBefore >= value.relayFirstDays) {
    return { error: "La relance doit avoir lieu après le premier « à relayer » : choisissez une relance plus proche du rendez-vous" };
  }
  return { value };
}

export async function saveReminderSettings(familyId, value, userId, now = new Date()) {
  const set = { ...value, updatedByUserId: userId, updatedAt: now };
  await db
    .insert(familyReminderSettings)
    .values({ familyId, ...set })
    .onConflictDoUpdate({ target: familyReminderSettings.familyId, set });
  return getReminderSettings(familyId);
}

export async function resetReminderSettings(familyId) {
  await db.delete(familyReminderSettings).where(eq(familyReminderSettings.familyId, familyId));
  return getReminderSettings(familyId);
}

// Cache par passage du worker : une seule lecture par famille.
export function reminderSettingsCache() {
  const cache = new Map();
  return async (familyId) => {
    if (!cache.has(familyId)) cache.set(familyId, await getReminderSettings(familyId));
    return cache.get(familyId);
  };
}
