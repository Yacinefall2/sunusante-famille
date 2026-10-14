import crypto from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { supportSessions, supportUsers } from "../db/schema.js";
import { hashPassword } from "./password.js";
import { normalizeEmail } from "./loginThrottle.js";
import { encryptTotpSecret, generateTotpSecret, otpauthUrl } from "./totp.js";
import { logSupportAction } from "./supportAudit.js";

// ── Comptes support : création, désactivation, double facteur ───────────────
// Uniquement en ligne de commande (scripts/creerSupport.js) : aucune route de
// l'API ne crée ni ne modifie un compte support.

export const MIN_SUPPORT_PASSWORD_LENGTH = 16;

// Mot de passe fort : 24 caractères aléatoires (≈ 140 bits).
export function generateStrongPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%+=";
  const bytes = crypto.randomBytes(24);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// Ferme toutes les sessions ouvertes d'un compte support.
async function revokeSupportSessions(supportUserId, at = new Date()) {
  await db
    .update(supportSessions)
    .set({ revokedAt: at })
    .where(and(eq(supportSessions.supportUserId, supportUserId), isNull(supportSessions.revokedAt)));
}

// Crée un compte support. Renvoie le compte, le mot de passe (à transmettre
// une seule fois) et le secret TOTP (adresse otpauth:// à scanner).
export async function createSupportUser({ email, name, password = null }) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("Adresse courriel invalide (--email)");
  const cleanName = String(name ?? "").trim();
  if (!cleanName || cleanName.length > 150) throw new Error("Nom requis (--nom), 150 caractères maximum");
  const finalPassword = password ?? generateStrongPassword();
  if (finalPassword.length < MIN_SUPPORT_PASSWORD_LENGTH) {
    throw new Error(`Le mot de passe d'un compte support doit contenir au moins ${MIN_SUPPORT_PASSWORD_LENGTH} caractères`);
  }
  const [existing] = await db.select({ id: supportUsers.id }).from(supportUsers).where(eq(supportUsers.email, normalized));
  if (existing) throw new Error(`Un compte support existe déjà avec l'adresse ${normalized}`);

  const secret = generateTotpSecret();
  const [user] = await db
    .insert(supportUsers)
    .values({
      email: normalized,
      name: cleanName,
      passwordHash: await hashPassword(finalPassword),
      totpSecretEncrypted: encryptTotpSecret(secret, normalized),
    })
    .returning();
  await logSupportAction({ action: "support_user_created", supportEmail: "ligne de commande", details: { compte: normalized } });
  return { user, password: finalPassword, secret, otpauthUrl: otpauthUrl(secret, normalized) };
}

// Désactive un compte support : connexion refusée, sessions fermées. Le
// compte n'est jamais supprimé (le journal d'audit le désigne).
export async function deactivateSupportUser(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("Adresse courriel invalide (--email)");
  const [user] = await db.update(supportUsers).set({ active: false }).where(eq(supportUsers.email, normalized)).returning();
  if (!user) throw new Error(`Aucun compte support avec l'adresse ${normalized}`);
  await revokeSupportSessions(user.id);
  await logSupportAction({ action: "support_user_deactivated", supportEmail: "ligne de commande", details: { compte: normalized } });
  return user;
}

// Nouveau secret TOTP (téléphone perdu, clé changée) : l'ancien cesse de
// fonctionner, les sessions sont fermées.
export async function resetSupportTotp(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("Adresse courriel invalide (--email)");
  const secret = generateTotpSecret();
  const [user] = await db
    .update(supportUsers)
    .set({ totpSecretEncrypted: encryptTotpSecret(secret, normalized), totpLastStep: null })
    .where(eq(supportUsers.email, normalized))
    .returning();
  if (!user) throw new Error(`Aucun compte support avec l'adresse ${normalized}`);
  await revokeSupportSessions(user.id);
  await logSupportAction({ action: "support_totp_reset", supportEmail: "ligne de commande", details: { compte: normalized } });
  return { user, secret, otpauthUrl: otpauthUrl(secret, normalized) };
}
