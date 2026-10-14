import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { supportSessions, supportUsers } from "../db/schema.js";
import { COOKIE_SECURE, hashToken } from "../lib/session.js";

// ── Session du support (espace /admin) ───────────────────────────────────────
// Entièrement SÉPARÉE de celle des familles : cookie distinct (admin_token),
// limité aux routes /api/admin, jeton aléatoire opaque (seule son empreinte
// est en base) — jamais un JWT de session famille. requireAuth (familles)
// ne lit que access_token : une session support n'ouvre aucune route
// famille ; requireSupport ne lit que admin_token : une session famille
// n'ouvre aucune route /api/admin.
// Durée : 30 minutes GLISSANTES (prolongées à chaque requête), sans jeton de
// rafraîchissement.

export const ADMIN_COOKIE = "admin_token";
export const ADMIN_COOKIE_PATH = "/api/admin";
export const SUPPORT_SESSION_TTL_MS = 30 * 60 * 1000;

export function setAdminCookie(res, token) {
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "strict",
    maxAge: SUPPORT_SESSION_TTL_MS,
    path: ADMIN_COOKIE_PATH,
  });
}

export function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE, { path: ADMIN_COOKIE_PATH });
}

// Ouvre une session pour un compte support ; renvoie le jeton (cookie).
export async function openSupportSession(supportUserId, now = new Date()) {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.insert(supportSessions).values({
    supportUserId,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + SUPPORT_SESSION_TTL_MS),
    createdAt: now,
  });
  return token;
}

export async function closeSupportSession(token, now = new Date()) {
  if (!token || typeof token !== "string") return;
  await db.update(supportSessions).set({ revokedAt: now }).where(eq(supportSessions.tokenHash, hashToken(token)));
}

export async function requireSupport(req, res, next) {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token || typeof token !== "string") {
    return res.status(401).json({ error: "Session support requise", code: "SUPPORT_AUTH_REQUIRED" });
  }
  try {
    const now = new Date();
    const [row] = await db
      .select({ session: supportSessions, user: { id: supportUsers.id, email: supportUsers.email, name: supportUsers.name, active: supportUsers.active } })
      .from(supportSessions)
      .innerJoin(supportUsers, eq(supportUsers.id, supportSessions.supportUserId))
      .where(and(eq(supportSessions.tokenHash, hashToken(token)), isNull(supportSessions.revokedAt), gt(supportSessions.expiresAt, now)));
    if (!row || !row.user.active) {
      clearAdminCookie(res);
      return res.status(401).json({ error: "Session support expirée, reconnectez-vous", code: "SUPPORT_AUTH_REQUIRED" });
    }
    // Glissement : 30 minutes à compter de cette requête.
    await db
      .update(supportSessions)
      .set({ expiresAt: new Date(now.getTime() + SUPPORT_SESSION_TTL_MS) })
      .where(eq(supportSessions.id, row.session.id));
    setAdminCookie(res, token);
    req.supportUser = { id: row.user.id, email: row.user.email, name: row.user.name };
    req.supportToken = token;
    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
}
