import { Router } from "express";
import { eq, and, isNull, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, refreshTokens, emailVerificationTokens, passwordResetTokens, emailChangeTokens } from "../db/schema.js";
import { hashPassword, comparePassword } from "../lib/password.js";
import { generateToken } from "../lib/token.js";
import { sendAccountExistsEmail, sendPasswordChangedAlert, sendVerificationEmail } from "../lib/mailer.js";
import { issuePasswordReset, passwordResetSentRecently } from "../lib/passwordReset.js";
import { isSuspended, suspendedLoginMessage } from "../lib/suspensionStatus.js";
import { logTechnical, requestMeta } from "../lib/technicalLog.js";
import {
  clearEmail,
  clearFailures,
  lockedMinutes,
  normalizeEmail,
  recordFailure,
  tooManyAttemptsMessage,
} from "../lib/loginThrottle.js";
import { WindowCounter, ipRateLimit } from "../lib/rateLimit.js";
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
const RESEND_MIN_INTERVAL_MS = 60 * 1000; // délai minimal entre deux envois à une même adresse (UC-62)
const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 150;
// Un jeton de rafraîchissement remplacé il y a peu peut légitimement revenir
// (deux onglets qui renouvellent en même temps) ; au-delà, c'est suspect.
const REUSE_GRACE_MS = 60 * 1000;

// Limite par adresse IP des routes qui envoient un courriel ou vérifient un
// secret (mot de passe, lien reçu) : freine les robots (inscriptions en masse,
// essais de mots de passe, envois de courriels vers des tiers). Large, car un
// opérateur mobile peut faire sortir beaucoup d'abonnés par la même adresse IP.
export const AUTH_IP_LIMIT = 100;
export const AUTH_IP_WINDOW_MS = 15 * 60 * 1000;
const authIpLimit = ipRateLimit({
  windowMs: AUTH_IP_WINDOW_MS,
  max: AUTH_IP_LIMIT,
  message: "Trop de requêtes depuis votre connexion. Réessayez dans quelques minutes.",
});

// Courriel « vous avez déjà un compte » : au plus un par minute et par
// adresse (pas de table pour s'en souvenir : compteur en mémoire, borné).
const accountExistsNotices = new WindowCounter({ windowMs: RESEND_MIN_INTERVAL_MS, max: 1 });

// Empreinte bcrypt d'un mot de passe aléatoire : comparée quand le compte
// n'existe pas, pour que la réponse prenne le même temps qu'avec un compte
// existant (sinon la durée révélerait quelles adresses sont inscrites).
let dummyHashPromise;
const dummyHash = () => (dummyHashPromise ??= hashPassword(generateToken()));

// Date arrondie à la seconde inférieure : les jetons d'accès émis avant (champ
// iat, en secondes) sont refusés par requireAuth, ceux émis juste après
// restent valables.
const secondFloor = () => new Date(Math.floor(Date.now() / 1000) * 1000);

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

// Un courriel de vérification est-il parti vers ce compte il y a moins d'une minute ?
async function verificationSentRecently(userId) {
  const [recent] = await db
    .select({ createdAt: emailVerificationTokens.createdAt })
    .from(emailVerificationTokens)
    .where(and(eq(emailVerificationTokens.userId, userId), isNull(emailVerificationTokens.consumedAt)))
    .orderBy(desc(emailVerificationTokens.createdAt))
    .limit(1);
  return Boolean(recent && Date.now() - new Date(recent.createdAt).getTime() < RESEND_MIN_INTERVAL_MS);
}

// Ferme toutes les sessions ouvertes d'un compte.
async function revokeSessions(userId, at = new Date()) {
  await db
    .update(refreshTokens)
    .set({ revokedAt: at })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

// Inscription — le compte naît NON vérifié (§6.1) : il n'a accès à rien tant
// que le lien reçu par courriel n'a pas été suivi. Aucune session n'est
// ouverte ici ; le frontend affiche l'écran d'attente à la place.
router.post("/register", authIpLimit, async (req, res) => {
  try {
    const { name, password } = req.body;
    const normalizedEmail = normalizeEmail(req.body.email);
    if (typeof name !== "string" || !name.trim() || !normalizedEmail || typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: "Nom, email et mot de passe (8 caractères min.) requis" });
    }
    if (name.trim().length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `Le nom ne doit pas dépasser ${MAX_NAME_LENGTH} caractères` });
    }

    // Toujours calculée, même si l'adresse existe : la durée de la réponse ne
    // trahit pas les comptes existants.
    const passwordHash = await hashPassword(password);
    // Réponse identique dans tous les cas, pour ne pas révéler qui a un compte.
    const response = { status: "pending_verification", email: normalizedEmail };

    const [existing] = await db.select().from(users).where(eq(users.email, normalizedEmail));
    if (existing?.emailVerified) {
      // Adresse déjà inscrite et vérifiée : la personne est prévenue par
      // courriel (au plus une fois par minute), son compte ne change pas.
      if (!accountExistsNotices.blockedMs(normalizedEmail)) {
        accountExistsNotices.add(normalizedEmail);
        await sendAccountExistsEmail({ to: existing.email, name: existing.name });
      }
      return res.status(201).json(response);
    }
    if (existing) {
      // Adresse inscrite mais jamais vérifiée : quelqu'un a pu l'inscrire à la
      // place de sa propriétaire (pré-détournement de compte). La nouvelle
      // inscription REMPLACE nom et mot de passe, et les liens de
      // vérification et sessions précédents sont annulés : seule la dernière
      // personne inscrite — celle qui reçoit le courriel — contrôle le compte.
      // Même délai minimal entre deux envois que /resend-verification.
      if (await verificationSentRecently(existing.id)) return res.status(201).json(response);
      const now = secondFloor();
      const [updated] = await db
        .update(users)
        .set({ name: name.trim(), passwordHash, passwordChangedAt: now })
        .where(and(eq(users.id, existing.id), eq(users.emailVerified, false)))
        .returning();
      if (!updated) return res.status(201).json(response); // vérifiée entre-temps
      await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, existing.id));
      await revokeSessions(existing.id, now);
      await issueVerificationEmail(updated);
      return res.status(201).json(response);
    }

    const [user] = await db
      .insert(users)
      .values({ name: name.trim(), email: normalizedEmail, passwordHash })
      .returning();

    await issueVerificationEmail(user);

    res.status(201).json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Renvoyer le courriel de vérification — seule action possible depuis
// l'écran "compte en attente de vérification" (UC-62).
router.post("/resend-verification", authIpLimit, async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body.email);
    if (!normalizedEmail) return res.status(400).json({ error: "Adresse courriel invalide" });

    const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail));
    // Réponse volontairement identique dans tous les cas (compte inconnu, déjà
    // vérifié, ou demande trop rapprochée de la précédente : rien n'est
    // envoyé), pour ne pas révéler quelles adresses sont enregistrées.
    if (!user || user.emailVerified) return res.json({ success: true });

    // Délai minimal entre deux envois — évite le spam accidentel du bouton.
    if (await verificationSentRecently(user.id)) return res.json({ success: true });

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
router.post("/verify-email/:token", authIpLimit, async (req, res) => {
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

    // Consommation conditionnelle : deux clics simultanés, un seul passe.
    const [claimed] = await db
      .update(emailVerificationTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(emailVerificationTokens.id, verification.id), isNull(emailVerificationTokens.consumedAt)))
      .returning();
    if (!claimed) return res.status(409).json({ error: "Ce lien a déjà été utilisé" });

    const [user] = await db.select().from(users).where(eq(users.id, verification.userId));
    if (!user) return res.status(404).json({ error: "Compte introuvable" });
    // Compte suspendu (UC-52) : l'adresse est bien vérifiée, mais aucune
    // session n'est ouverte.
    if (isSuspended(user)) {
      await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
      return res.status(403).json({ error: suspendedLoginMessage(user), code: "ACCOUNT_SUSPENDED" });
    }

    // Sessions ouvertes avant la vérification (connexion permise sans adresse
    // vérifiée) : fermées. Seule la session ouverte par ce lien subsiste.
    const now = secondFloor();
    const wasVerified = user.emailVerified;
    await db
      .update(users)
      .set(wasVerified ? { emailVerified: true } : { emailVerified: true, passwordChangedAt: now })
      .where(eq(users.id, user.id));
    if (!wasVerified) await revokeSessions(user.id, now);

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

router.post("/login", authIpLimit, async (req, res) => {
  try {
    const { password } = req.body;
    if (typeof req.body.email !== "string" || !req.body.email.trim() || typeof password !== "string" || !password) {
      return res.status(400).json({ error: "Email et mot de passe requis" });
    }
    const normalizedEmail = normalizeEmail(req.body.email);
    if (!normalizedEmail) return res.status(400).json({ error: "Adresse courriel invalide" });

    // Trop d'échecs récents (cette adresse, ou cette connexion) : refus, même
    // avec le bon mot de passe, jusqu'à la fin du blocage (protection contre
    // l'essai de mots de passe en série — voir lib/loginThrottle.js).
    const minutes = lockedMinutes(normalizedEmail, req.ip);
    if (minutes > 0) return res.status(429).json({ error: tooManyAttemptsMessage(minutes) });

    const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail));
    // Compte inconnu, ou compte sans mot de passe (créé avec « Continuer avec
    // Google ») : comparaison quand même, avec une empreinte factice, pour une
    // durée de réponse identique. Le refus est le MÊME message générique
    // qu'un mauvais mot de passe : l'écran ne révèle pas qu'un compte existe ;
    // la page de connexion rappelle d'utiliser le bouton Google.
    const valid = await comparePassword(password, user?.passwordHash ?? (await dummyHash()));
    if (!user || !user.passwordHash || !valid) {
      recordFailure(normalizedEmail, req.ip);
      // Journal technique (UC-53) : jamais le mot de passe ni l'adresse en clair.
      await logTechnical({
        level: "warn",
        category: "auth",
        message: !user
          ? "Connexion refusée : compte inconnu"
          : user.passwordHash
            ? "Connexion refusée : mot de passe incorrect"
            : "Connexion refusée : compte sans mot de passe (connexion Google)",
        metadata: { ...requestMeta(req), userId: user?.id },
      });
      return res.status(401).json({ error: "Identifiants invalides" });
    }
    clearFailures(normalizedEmail, req.ip);

    // Compte suspendu par le support (UC-52) : révélé SEULEMENT après un mot
    // de passe correct (sinon, l'écran trahirait quels comptes sont suspendus).
    if (isSuspended(user)) {
      await logTechnical({ level: "warn", category: "auth", message: "Connexion refusée : compte suspendu", metadata: { ...requestMeta(req), userId: user.id } });
      return res.status(403).json({ error: suspendedLoginMessage(user), code: "ACCOUNT_SUSPENDED" });
    }
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await logTechnical({ category: "auth", message: "Connexion réussie", metadata: { ...requestMeta(req), userId: user.id } });

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
    res.json({ id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified, seniorMode: user.seniorMode });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Mot de passe oublié : envoie un lien de réinitialisation. Réponse
// identique que le compte existe ou non — et même quand une demande trop
// rapprochée est ignorée —, pour ne pas révéler quelles adresses sont
// enregistrées.
router.post("/forgot-password", authIpLimit, async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body.email);
    if (!normalizedEmail) return res.status(400).json({ error: "Adresse courriel invalide" });

    const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail));
    if (!user) return res.json({ success: true });

    // Délai minimal entre deux envois : la demande est ignorée en silence.
    if (await passwordResetSentRecently(user.id)) return res.json({ success: true });

    // Une nouvelle demande annule les liens encore valides (lib/passwordReset.js,
    // mécanisme partagé avec le support — UC-50).
    await issuePasswordReset(user);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Nouveau mot de passe via le lien reçu par courriel. Toutes les sessions
// ouvertes sont fermées ; la personne se reconnecte avec le nouveau mot de
// passe. Le lien prouvant l'accès à la boîte, l'adresse est tenue pour vérifiée.
router.post("/reset-password/:token", authIpLimit, async (req, res) => {
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
    await revokeSessions(reset.userId, now);
    clearEmail(user.email);
    await sendPasswordChangedAlert(user);

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Confirmation d'une nouvelle adresse (lien envoyé à celle-ci depuis « Mon
// compte »). Public : le lien suffit, comme pour la vérification initiale.
router.post("/confirm-email-change/:token", authIpLimit, async (req, res) => {
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

    const now = new Date();
    const [claimed] = await db
      .update(emailChangeTokens)
      .set({ consumedAt: now })
      .where(and(eq(emailChangeTokens.id, change.id), isNull(emailChangeTokens.consumedAt)))
      .returning();
    if (!claimed) return res.status(409).json({ error: "Ce lien a déjà été utilisé" });

    await db.update(users).set({ email: change.newEmail, emailVerified: true }).where(eq(users.id, change.userId));
    // Un lien « Mot de passe oublié » envoyé à l'ANCIENNE adresse ne doit plus
    // permettre de reprendre le compte : les demandes en attente sont annulées.
    await db
      .update(passwordResetTokens)
      .set({ consumedAt: now })
      .where(and(eq(passwordResetTokens.userId, change.userId), isNull(passwordResetTokens.consumedAt)));
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
    // Compte suspendu (UC-52) : plus aucun renouvellement de session.
    if (!user || isSuspended(user)) {
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

// seniorMode (réglage d'affichage, UC-25) : l'interface s'adapte dès la connexion.
router.get("/me", requireAuth, async (req, res) => {
  try {
    const [row] = await db.select({ seniorMode: users.seniorMode }).from(users).where(eq(users.id, req.user.id));
    res.json({
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      emailVerified: req.user.emailVerified,
      seniorMode: !!row?.seniorMode,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;