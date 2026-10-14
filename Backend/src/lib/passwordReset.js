import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { passwordResetTokens } from "../db/schema.js";
import { generateToken } from "./token.js";
import { hashToken } from "./session.js";
import { sendPasswordResetEmail } from "./mailer.js";

// Lien « Mot de passe oublié » : mécanisme commun à la page publique
// (routes/auth.js) et au support qui assiste une récupération (UC-50). Le
// lien part TOUJOURS à l'adresse du compte ; personne d'autre ne le voit.
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 heure
export const RESET_MIN_INTERVAL_MS = 60 * 1000;

// Un lien a-t-il été demandé il y a moins d'une minute ?
export async function passwordResetSentRecently(userId, now = new Date()) {
  const [recent] = await db
    .select({ createdAt: passwordResetTokens.createdAt })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.userId, userId))
    .orderBy(desc(passwordResetTokens.createdAt))
    .limit(1);
  return Boolean(recent && now.getTime() - new Date(recent.createdAt).getTime() < RESET_MIN_INTERVAL_MS);
}

// Annule les liens encore valides, en crée un nouveau et l'envoie.
export async function issuePasswordReset(user, now = new Date()) {
  await db
    .update(passwordResetTokens)
    .set({ consumedAt: now })
    .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.consumedAt)));
  const token = generateToken();
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
  });
  await sendPasswordResetEmail({ to: user.email, name: user.name, token });
}
