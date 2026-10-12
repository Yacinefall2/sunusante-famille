import { Router } from "express";
import { eq, and, isNull, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, refreshTokens, emailVerificationTokens, passwordResetTokens, emailChangeTokens } from "../db/schema.js";
import { hashPassword, comparePassword } from "../lib/password.js";
import { generateToken } from "../lib/token.js";
import { sendAccountExistsEmail, sendPasswordChangedAlert, sendPasswordResetEmail, sendVerificationEmail } from "../lib/mailer.js";
import { clearFailures, lockedMinutes, recordFailure } from "../lib/loginThrottle.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
} from "../lib/jwt.js";
import { requireAuth } from "../middleware/auth.js";
import { clearAuthCookies, hashToken, setAuthCookies } from "../lib/session.js";

const router = Router();

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 heures
const RESEND_MIN_INTERVAL_MS = 60 * 1000; // délai minimal entre deux renvois (UC-62)
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 heure
const MIN_PASSWORD_LENGTH = 8;
// Un jeton de rafraîchissement remplacé il y a peu peut légitimement revenir
// (deux onglets qui renouvellent en même temps) ; au-delà, c'est suspect.
const REUSE_GRACE_MS = 60 * 1000;

// Crée un nouveau jeton de vérification pour un utilisateur et envoie le
// courriel — utilisé à la fois par /register et par /resend-verification.
async function issueVerificationEmail(user) {
  const token = generateToken();
  await db.insert(emailVerificationTokens).values({
    userId: user.id,
    // Empreinte seule : le jeton en clair ne part que par courriel.
    token: hashToken(token),
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
    // Adresse déjà inscrite : même réponse qu'une inscription réussie, pour ne
    // pas révéler qui a un compte ; la personne est prévenue par courriel.
    const [existing] = await db.select().from(users).where(eq(users.email, normalizedEmail));
    if (existing) {
      if (existing.emailVerified) await sendAccountExistsEmail({ to: existing.email, name: existing.name });
      else await issueVerificationEmail(existing);
      return res.status(201).json({ status: "pending_verification", email: existing.email });
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

    // Déjà vérifiée : rien à envoyer, même réponse (aucune information révélée).
    if (user.emailVerified) return res.json({ success: true });

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
      .where(eq(emailVerificationTokens.token, hashToken(token)));

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

    const normalizedEmail = email.toLowerCase().trim();
    // Trop d'échecs récents sur cette adresse : refus, même avec le bon mot
    // de passe, jusqu'à la fin de la fenêtre (protection contre l'essai de
    // mots de passe en série).
    const minutes = lockedMinutes(normalizedEmail);
    if (minutes > 0) {
      return res.status(429).json({
        error: `Trop de tentatives. Réessayez dans ${minutes} minute${minutes > 1 ? "s" : ""}, ou utilisez « Mot de passe oublié ».`,
      });
    }

    const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail));
    const valid = user ? await comparePassword(password, user.passwordHash) : false;
    if (!valid) {
      recordFailure(normalizedEmail);
      return res.status(401).json({ error: "Identifiants invalides" });
    }
    clearFailures(normalizedEmail);

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

// Mot de passe oublié : envoie un lien de réinitialisation. Réponse
// identique que le compte existe ou non, pour ne pas révéler quelles
// adresses sont enregistrées.
router.post("/forgot-password", async (req, res) => {
  try {
    const normalizedEmail = String(req.body.email ?? "").toLowerCase().trim();
    if (!normalizedEmail) return res.status(400).json({ error: "Email requis" });

    const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail));
    if (!user) return res.json({ success: true });

    const [recent] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id))
      .orderBy(desc(passwordResetTokens.createdAt))
      .limit(1);
    if (recent && Date.now() - new Date(recent.createdAt).getTime() < RESEND_MIN_INTERVAL_MS) {
      return res.status(429).json({ error: "Merci de patienter une minute avant de redemander un courriel" });
    }

    // Une nouvelle demande annule les liens encore valides.
    const now = new Date();
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
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Nouveau mot de passe via le lien reçu par courriel. Toutes les sessions
// ouvertes sont fermées ; la personne se reconnecte avec le nouveau mot de
// passe. Le lien prouvant l'accès à la boîte, l'adresse est tenue pour vérifiée.
router.post("/reset-password/:token", async (req, res) => {
  try {
    const password = req.body.password;
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères` });
    }

    const [reset] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, hashToken(req.params.token)));
    if (!reset) return res.status(404).json({ error: "Lien de réinitialisation invalide" });
    if (reset.consumedAt) return res.status(409).json({ error: "Ce lien a déjà été utilisé ou remplacé par une demande plus récente" });
    if (reset.expiresAt < new Date()) return res.status(410).json({ error: "Ce lien a expiré, faites une nouvelle demande" });

    // Consommation conditionnelle : deux envois simultanés, un seul passe.
    const now = new Date();
    const [claimed] = await db
      .update(passwordResetTokens)
      .set({ consumedAt: now })
      .where(and(eq(passwordResetTokens.id, reset.id), isNull(passwordResetTokens.consumedAt)))
      .returning();
    if (!claimed) return res.status(409).json({ error: "Ce lien a déjà été utilisé" });

    const passwordHash = await hashPassword(password);
    const [user] = await db
      .update(users)
      .set({ passwordHash, emailVerified: true, passwordChangedAt: now })
      .where(eq(users.id, reset.userId))
      .returning();
    await db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.userId, reset.userId), isNull(refreshTokens.revokedAt)));
    clearFailures(user.email);
    await sendPasswordChangedAlert(user);

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Confirmation d'une nouvelle adresse (lien envoyé à celle-ci depuis « Mon
// compte »). Public : le lien suffit, comme pour la vérification initiale.
router.post("/confirm-email-change/:token", async (req, res) => {
  try {
    const [change] = await db
      .select()
      .from(emailChangeTokens)
      .where(eq(emailChangeTokens.tokenHash, hashToken(req.params.token)));
    if (!change) return res.status(404).json({ error: "Lien de confirmation invalide" });
    if (change.consumedAt) return res.status(409).json({ error: "Ce lien a déjà été utilisé ou remplacé par une demande plus récente" });
    if (change.expiresAt < new Date()) return res.status(410).json({ error: "Ce lien a expiré, refaites la demande depuis « Mon compte »" });

    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, change.newEmail));
    if (taken) return res.status(409).json({ error: "Un compte existe déjà avec cette adresse" });

    const [claimed] = await db
      .update(emailChangeTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(emailChangeTokens.id, change.id), isNull(emailChangeTokens.consumedAt)))
      .returning();
    if (!claimed) return res.status(409).json({ error: "Ce lien a déjà été utilisé" });

    await db.update(users).set({ email: change.newEmail, emailVerified: true }).where(eq(users.id, change.userId));
    res.json({ email: change.newEmail });
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

    if (stored?.revokedAt && Date.now() - stored.revokedAt.getTime() > REUSE_GRACE_MS) {
      // Jeton déjà remplacé depuis longtemps présenté à nouveau : signe d'un
      // vol. Toutes les sessions du compte sont fermées par précaution.
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, stored.userId), isNull(refreshTokens.revokedAt)));
    }
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      clearAuthCookies(res);
      return res.status(401).json({ error: "Session expirée, reconnexion requise" });
    }

    const [user] = await db.select().from(users).where(eq(users.id, payload.sub));
    if (!user) {
      clearAuthCookies(res);
      return res.status(401).json({ error: "Session expirée, reconnexion requise" });
    }

    // Rotation atomique : deux renouvellements simultanés, un seul aboutit.
    const [rotated] = await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, stored.id), isNull(refreshTokens.revokedAt)))
      .returning();
    if (!rotated) {
      clearAuthCookies(res);
      return res.status(401).json({ error: "Session expirée, reconnexion requise" });
    }

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