import { Router } from "express";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { supportUsers } from "../db/schema.js";
import { comparePassword, hashPassword } from "../lib/password.js";
import { generateToken } from "../lib/token.js";
import { normalizeEmail } from "../lib/loginThrottle.js";
import { WindowCounter } from "../lib/rateLimit.js";
import { decryptTotpSecret, verifyTotp } from "../lib/totp.js";
import { logSupportAction } from "../lib/supportAudit.js";
import { logTechnical, requestMeta } from "../lib/technicalLog.js";
import { clearAdminCookie, closeSupportSession, openSupportSession, requireSupport, setAdminCookie } from "../middleware/supportAuth.js";

// ── Connexion du support : mot de passe + code à 6 chiffres (TOTP) ───────────
// Limiteur dédié, plus strict que celui des familles : 5 échecs (par adresse
// ou par connexion) bloquent 15 minutes, même avec les bons identifiants.

const router = Router();

export const SUPPORT_MAX_FAILURES = 5;
export const SUPPORT_LOCK_MS = 15 * 60 * 1000;
const failuresByEmail = new WindowCounter({ windowMs: SUPPORT_LOCK_MS, max: SUPPORT_MAX_FAILURES, lockMs: SUPPORT_LOCK_MS });
const failuresByIp = new WindowCounter({ windowMs: SUPPORT_LOCK_MS, max: SUPPORT_MAX_FAILURES, lockMs: SUPPORT_LOCK_MS });

const INVALID = "Identifiants ou code invalides";

let dummyHashPromise;
const dummyHash = () => (dummyHashPromise ??= hashPassword(generateToken()));

const present = (u) => ({ id: u.id, name: u.name, email: u.email });

router.post("/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const code = typeof req.body?.code === "string" ? req.body.code.replace(/\s/g, "") : "";
    if (!email || typeof password !== "string" || !password || !code) {
      return res.status(400).json({ error: "Adresse, mot de passe et code à 6 chiffres requis" });
    }
    const ipKey = req.ip || "inconnue";
    const blocked = Math.max(failuresByEmail.blockedMs(email), failuresByIp.blockedMs(ipKey));
    if (blocked > 0) {
      const minutes = Math.ceil(blocked / 60000);
      return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${minutes} minute${minutes > 1 ? "s" : ""}.` });
    }

    const [user] = await db.select().from(supportUsers).where(eq(supportUsers.email, email));
    const passwordOk = await comparePassword(password, user ? user.passwordHash : await dummyHash());
    let step = null;
    if (user && user.active && passwordOk) {
      const secret = decryptTotpSecret(user.totpSecretEncrypted, user.email);
      step = secret ? verifyTotp(secret, code, { lastStep: user.totpLastStep }) : null;
    }
    // Code non réutilisable : le pas reconnu doit être postérieur au dernier
    // pas utilisé (mise à jour conditionnelle : deux envois simultanés du
    // même code, un seul passe).
    let accepted = null;
    if (step !== null) {
      [accepted] = await db
        .update(supportUsers)
        .set({ totpLastStep: step, lastLoginAt: new Date() })
        .where(and(eq(supportUsers.id, user.id), or(isNull(supportUsers.totpLastStep), lt(supportUsers.totpLastStep, step))))
        .returning();
    }

    if (!accepted) {
      const wasBlocked = failuresByEmail.blockedMs(email) > 0 || failuresByIp.blockedMs(ipKey) > 0;
      failuresByEmail.add(email);
      failuresByIp.add(ipKey);
      const nowBlocked = failuresByEmail.blockedMs(email) > 0 || failuresByIp.blockedMs(ipKey) > 0;
      await logSupportAction({
        supportUser: user ?? null,
        supportEmail: email,
        action: "login_failed",
        details: { motif: !user ? "compte inconnu" : !user.active ? "compte désactivé" : !passwordOk ? "mot de passe" : "code" },
        ip: req.ip,
      });
      await logTechnical({ level: "warn", category: "support", message: "Connexion support refusée", metadata: { ...requestMeta(req), supportUserId: user?.id } });
      if (nowBlocked && !wasBlocked) {
        await logTechnical({ level: "warn", category: "security", message: "Connexion support bloquée (trop d'échecs)", metadata: { ...requestMeta(req), limiter: "support" } });
      }
      return res.status(401).json({ error: INVALID });
    }

    failuresByEmail.delete(email);
    const token = await openSupportSession(user.id);
    setAdminCookie(res, token);
    await logSupportAction({ supportUser: user, action: "login_success", ip: req.ip });
    await logTechnical({ category: "support", message: "Connexion support réussie", metadata: { ...requestMeta(req), supportUserId: user.id } });
    res.json(present(user));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/logout", requireSupport, async (req, res) => {
  try {
    await closeSupportSession(req.supportToken);
    await logSupportAction({ supportUser: req.supportUser, action: "logout", ip: req.ip });
    clearAdminCookie(res);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    clearAdminCookie(res);
    res.json({ success: true });
  }
});

router.get("/me", requireSupport, (req, res) => {
  res.json(present(req.supportUser));
});

export default router;
