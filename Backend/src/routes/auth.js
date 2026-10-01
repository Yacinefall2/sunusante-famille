import { Router } from "express";
import crypto from "node:crypto";
import { eq, and, isNull, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, refreshTokens, emailVerificationTokens } from "../db/schema.js";
import { hashPassword, comparePassword } from "../lib/password.js";
import { generateToken } from "../lib/token.js";
import { sendVerificationEmail } from "../lib/mailer.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
} from "../lib/jwt.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 heures
const RESEND_MIN_INTERVAL_MS = 60 * 1000; // délai minimal entre deux renvois (UC-62)

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie("access_token", accessToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    maxAge: ACCESS_TOKEN_TTL_MS,
    path: "/",
  });
  res.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    maxAge: REFRESH_TOKEN_TTL_MS,
    // Le refresh token n'est envoyé que vers les routes d'authentification
    path: "/api/auth",
  });
}

function clearAuthCookies(res) {
  res.clearCookie("access_token", { path: "/" });
  res.clearCookie("refresh_token", { path: "/api/auth" });
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Crée un nouveau jeton de vérification pour un utilisateur et envoie le
// courriel — utilisé à la fois par /register et par /resend-verification.
async function issueVerificationEmail(user) {
  const token = generateToken();
  await db.insert(emailVerificationTokens).values({
    userId: user.id,
    token,
    expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
  });
  await sendVerificationEmail({ to: user.email, name: user.name, token });
}

// Inscription — le compte naît NON vérifié (§6.1) : il n'a accès à rien tant
// que le lien reçu par courriel n'a pas été suivi. Aucune session n'est
// ouverte ici ; le frontend affiche l'écran d'attente à la place.
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name?.trim() || !email?.trim() || !password || password.length < 8) {
      return res.status(400).json({ error: "Nom, email et mot de passe (8 caractères min.) requis" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await db.select().from(users).where(eq(users.email, normalizedEmail));
    if (existing.length > 0) {
      return res.status(409).json({ error: "Un compte existe déjà avec cet email" });
    }

    const passwordHash = await hashPassword(password);
    const [user] = await db
      .insert(users)
      .values({ name: name.trim(), email: normalizedEmail, passwordHash })
      .returning();

    await issueVerificationEmail(user);

    res.status(201).json({ status: "pending_verification", email: user.email });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Renvoyer le courriel de vérification — seule action possible depuis
// l'écran "compte en attente de vérification" (UC-62).
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: "Email requis" });

    const normalizedEmail = email.toLowerCase().trim();
    const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail));
    // Réponse volontairement identique que le compte existe ou non, pour ne
    // pas révéler quelles adresses sont enregistrées.
    if (!user) return res.json({ success: true });

    if (user.emailVerified) {
      return res.status(400).json({ error: "Cette adresse est déjà vérifiée, vous pouvez vous connecter" });
    }

    // Délai minimal entre deux envois — évite le spam accidentel du bouton.
    const [recent] = await db
      .select()
      .from(emailVerificationTokens)
      .where(and(eq(emailVerificationTokens.userId, user.id), isNull(emailVerificationTokens.consumedAt)))
      .orderBy(desc(emailVerificationTokens.createdAt))
      .limit(1);
    if (recent && Date.now() - new Date(recent.createdAt).getTime() < RESEND_MIN_INTERVAL_MS) {
      return res.status(429).json({ error: "Merci de patienter une minute avant de redemander un courriel" });
    }

    await issueVerificationEmail(user);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Confirmer l'adresse via le lien reçu par courriel — public (pas de session
// requise, puisque c'est précisément ce qui va en créer une). Marque
// l'adresse vérifiée, active le compte, consomme le lien, puis connecte
// automatiquement la personne (§6.1 étape 4).
router.post("/verify-email/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const [verification] = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.token, token));

    if (!verification) return res.status(404).json({ error: "Lien de vérification invalide" });
    if (verification.consumedAt) return res.status(409).json({ error: "Ce lien a déjà été utilisé" });
    if (verification.expiresAt < new Date()) {
      return res.status(410).json({ error: "Ce lien a expiré, demandez-en un nouveau" });
    }

    const [user] = await db.select().from(users).where(eq(users.id, verification.userId));
    if (!user) return res.status(404).json({ error: "Compte introuvable" });

    await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
    await db
      .update(emailVerificationTokens)
      .set({ consumedAt: new Date() })
      .where(eq(emailVerificationTokens.id, verification.id));

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });

    setAuthCookies(res, accessToken, refreshToken);
    res.json({ id: user.id, name: user.name, email: user.email, emailVerified: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email?.trim() || !password) {
      return res.status(400).json({ error: "Email et mot de passe requis" });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase().trim()));
    if (!user) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    const valid = await comparePassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });

    // Connexion autorisée même si l'adresse n'est pas encore vérifiée : la
    // personne doit pouvoir revoir l'écran d'attente et renvoyer le
    // courriel. C'est requireVerifiedEmail qui bloque ensuite l'accès aux
    // fonctionnalités (familles, dossiers...), pas la connexion elle-même.
    setAuthCookies(res, accessToken, refreshToken);
    res.json({ id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Renouvelle l'access token à partir du refresh token (rotation : l'ancien
// refresh token est révoqué et remplacé par un nouveau à chaque appel).
router.post("/refresh", async (req, res) => {
  try {
    const token = req.cookies?.refresh_token;
    if (!token) return res.status(401).json({ error: "Non authentifié" });

    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      clearAuthCookies(res);
      return res.status(401).json({ error: "Session expirée, reconnexion requise" });
    }

    const tokenHash = hashToken(token);
    const [stored] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      clearAuthCookies(res);
      return res.status(401).json({ error: "Session expirée, reconnexion requise" });
    }

    const [user] = await db.select().from(users).where(eq(users.id, payload.sub));
    if (!user) {
      clearAuthCookies(res);
      return res.status(401).json({ error: "Session expirée, reconnexion requise" });
    }

    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, stored.id));

    const newAccessToken = signAccessToken(user);
    const newRefreshToken = signRefreshToken(user);
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: hashToken(newRefreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });

    setAuthCookies(res, newAccessToken, newRefreshToken);
    res.json({ id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const token = req.cookies?.refresh_token;
    if (token) {
      const tokenHash = hashToken(token);
      await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, tokenHash));
    }
    clearAuthCookies(res);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    clearAuthCookies(res);
    res.json({ success: true });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, email: req.user.email, emailVerified: req.user.emailVerified });
});

export default router;