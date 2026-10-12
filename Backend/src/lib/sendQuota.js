import { and, count, eq, gte } from "drizzle-orm";
import { db } from "../db/index.js";

// Plafond d'envois de courriels déclenchés par un compte (invitations, liens
// médecin) sur 24 heures glissantes : empêche d'utiliser l'application pour
// envoyer du courrier en masse à des adresses quelconques.
export const DAILY_SEND_LIMIT = 20;

export async function overDailyQuota(table, userColumn, userId, limit = DAILY_SEND_LIMIT) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ n }] = await db
    .select({ n: count() })
    .from(table)
    .where(and(eq(userColumn, userId), gte(table.createdAt, since)));
  return n >= limit;
}

export const QUOTA_MESSAGE = `Limite atteinte : ${DAILY_SEND_LIMIT} envois par 24 heures. Réessayez plus tard.`;
