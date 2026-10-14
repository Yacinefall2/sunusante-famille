import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailVerificationTokens, googleSignupTokens, refreshTokens, users } from "../db/schema.js";
import { generateToken } from "./token.js";
import { hashToken, setAuthCookies } from "./session.js";
import { signAccessToken, signRefreshToken, REFRESH_TOKEN_TTL_MS } from "./jwt.js";
import { normalizeEmail } from "./loginThrottle.js";
import { ipRateLimit } from "./rateLimit.js";
import { isSuspended, suspendedLoginMessage } from "./suspensionStatus.js";
import { logTechnical, requestMeta } from "./technicalLog.js";
import { sendGoogleLinkedEmail } from "./mailer.js";

// ── Connexion avec Google (Google Identity Services) ─────────────────────────
// Le bouton officiel « Continuer avec Google » (frontend) renvoie un JETON
// D'IDENTITÉ (JWT signé par Google). Le frontend le transmet tel quel ; c'est
// ICI qu'il est vérifié — jamais de confiance accordée à son contenu côté
// navigateur — avec la bibliothèque officielle google-auth-library :
// signature (clés publiques de Google), audience = GOOGLE_CLIENT_ID, émetteur,
// expiration. On exige en plus une adresse vérifiée par Google
// (email_verified === true) et un nonce émis par ce serveur, à usage unique
// (contre le rejeu d'un jeton intercepté).
//
// GOOGLE_CLIENT_ID est FACULTATIVE : sans elle, le bouton n'apparaît pas et
// les routes Google répondent 404. Aucun secret client n'est nécessaire.
// Lue à chaque appel (et non au démarrage) pour pouvoir être changée sans
// toucher au code — et activée ou non par les tests.
export function googleClientId() {
  const value = process.env.GOOGLE_CLIENT_ID?.trim();
  return value ? value : null;
}

export const GOOGLE_NOT_CONFIGURED = "La connexion avec Google n'est pas activée sur ce serveur";

export function requireGoogleConfigured(req, res, next) {
  if (!googleClientId()) return res.status(404).json({ error: GOOGLE_NOT_CONFIGURED });
  next();
}

// Limites par adresse IP (mêmes ordres de grandeur que les autres routes
// d'authentification). Le nonce est demandé à chaque affichage du bouton :
// limite plus large.
export const GOOGLE_IP_LIMIT = 100;
export const GOOGLE_IP_WINDOW_MS = 15 * 60 * 1000;
export const googleIpLimit = ipRateLimit({
  windowMs: GOOGLE_IP_WINDOW_MS,
  max: GOOGLE_IP_LIMIT,
  name: "google",
  message: "Trop de requêtes depuis votre connexion. Réessayez dans quelques minutes.",
});
export const googleNonceLimit = ipRateLimit({
  windowMs: GOOGLE_IP_WINDOW_MS,
  max: GOOGLE_IP_LIMIT * 3,
  name: "google-nonce",
  message: "Trop de requêtes depuis votre connexion. Réessayez dans quelques minutes.",
});

// ── Nonce (contre le rejeu) ──────────────────────────────────────────────────
// Le frontend demande un nonce au serveur et le passe à Google
// (google.accounts.id.initialize({ nonce })) ; Google le recopie dans le
// jeton d'identité. Le serveur n'accepte qu'un nonce qu'il a lui-même émis
// (signature HMAC), non expiré (10 minutes) et jamais utilisé : un jeton
// d'identité volé ne peut donc pas être rejoué. Les nonces consommés sont
// retenus en mémoire jusqu'à leur expiration (suffisant pour un seul serveur
// backend, comme les autres compteurs de lib/rateLimit.js).
export const NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_USED_NONCES = 50000;
const usedNonces = new Map(); // nonce -> date d'expiration (ms)

const nonceSecret = () => `google-nonce:${process.env.JWT_ACCESS_SECRET}`;
const nonceSignature = (body) => crypto.createHmac("sha256", nonceSecret()).update(body).digest("base64url");

export function issueNonce(now = Date.now()) {
  const body = `${crypto.randomBytes(16).toString("base64url")}.${now + NONCE_TTL_MS}`;
  return `${body}.${nonceSignature(body)}`;
}

function pruneNonces(now) {
  for (const [nonce, exp] of usedNonces) if (exp <= now) usedNonces.delete(nonce);
  // Toujours trop : les plus anciens sont oubliés (ils expirent de toute façon).
  if (usedNonces.size >= MAX_USED_NONCES) {
    for (const nonce of usedNonces.keys()) {
      if (usedNonces.size < MAX_USED_NONCES * 0.9) break;
      usedNonces.delete(nonce);
    }
  }
}

// Vrai si le nonce est authentique, non expiré et jamais présenté ; il est
// alors consommé.
export function consumeNonce(nonce, now = Date.now()) {
  if (typeof nonce !== "string" || nonce.length > 200) return false;
  const parts = nonce.split(".");
  if (parts.length !== 3) return false;
  const [random, exp, signature] = parts;
  const expected = nonceSignature(`${random}.${exp}`);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  if (usedNonces.has(nonce)) return false;
  pruneNonces(now);
  usedNonces.set(nonce, expiresAt);
  return true;
}

// ── Vérification du jeton d'identité ─────────────────────────────────────────
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const MAX_CREDENTIAL_LENGTH = 8192;
const MAX_NAME_LENGTH = 150;

let oauthClient;
// Vérificateur réel : google-auth-library contrôle la signature (clés
// publiques de Google, mises en cache par la bibliothèque), l'audience,
// l'émetteur et l'expiration, puis renvoie le contenu du jeton.
async function googleLibraryVerifier(idToken, audience) {
  if (!oauthClient) {
    const { OAuth2Client } = await import("google-auth-library");
    oauthClient = new OAuth2Client();
  }
  const ticket = await oauthClient.verifyIdToken({ idToken, audience });
  return ticket.getPayload();
}

let verifier = googleLibraryVerifier;

// Pour les tests uniquement : remplace l'appel à Google par un faux
// vérificateur (aucun test n'appelle Google). Sans argument : remet le vrai.
export function setGoogleTokenVerifier(fn) {
  verifier = fn ?? googleLibraryVerifier;
}

// Messages affichés selon le motif du refus (jamais le détail technique).
const REJECTION_MESSAGES = {
  adresse_non_verifiee:
    "Votre adresse Google n'est pas vérifiée par Google : vérifiez-la auprès de Google, ou utilisez votre adresse et un mot de passe.",
  nonce_invalide: "La connexion avec Google a expiré : cliquez de nouveau sur le bouton Google.",
};
const DEFAULT_REJECTION = "Connexion avec Google impossible. Réessayez, ou utilisez votre adresse et votre mot de passe.";

// Vérifie le jeton reçu du bouton Google. Renvoie { ok: true, identity:
// { sub, email, name } } ou { ok: false, reason }.
export async function verifyGoogleCredential(credential, now = Date.now()) {
  const clientId = googleClientId();
  if (!clientId) return { ok: false, reason: "non_configure" };
  if (typeof credential !== "string" || !credential || credential.length > MAX_CREDENTIAL_LENGTH) {
    return { ok: false, reason: "jeton_absent" };
  }
  let payload;
  try {
    payload = await verifier(credential, clientId);
  } catch {
    return { ok: false, reason: "jeton_invalide" };
  }
  if (!payload || typeof payload !== "object") return { ok: false, reason: "jeton_invalide" };
  // Contrôles déjà faits par la bibliothèque, refaits ici par précaution
  // (défense en profondeur : la sécurité ne repose pas sur un seul appel).
  if (!GOOGLE_ISSUERS.includes(payload.iss)) return { ok: false, reason: "emetteur_invalide" };
  if (payload.aud !== clientId) return { ok: false, reason: "audience_invalide" };
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return { ok: false, reason: "jeton_expire" };
  if (payload.email_verified !== true) return { ok: false, reason: "adresse_non_verifiee" };
  const email = normalizeEmail(payload.email);
  if (!email) return { ok: false, reason: "adresse_invalide" };
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255) return { ok: false, reason: "jeton_invalide" };
  if (!consumeNonce(payload.nonce, now)) return { ok: false, reason: "nonce_invalide" };
  const name = typeof payload.name === "string" ? payload.name.trim().slice(0, MAX_NAME_LENGTH) : "";
  return { ok: true, identity: { sub: payload.sub, email, name: name || email.split("@")[0].slice(0, MAX_NAME_LENGTH) } };
}

// Refus d'un jeton : noté au journal technique (motif seul, jamais le jeton
// ni l'adresse), puis réponse en français.
export async function rejectGoogleCredential(req, res, reason, userId) {
  await logTechnical({
    level: "warn",
    category: "auth",
    message: `Connexion Google refusée : ${reason.replace(/_/g, " ")}`,
    metadata: { ...requestMeta(req), userId, errorCode: reason },
  });
  if (reason === "non_configure") return res.status(404).json({ error: GOOGLE_NOT_CONFIGURED });
  // 400 et non 401 : un 401 ferait croire au frontend que SA session a
  // expiré (renouvellement automatique, puis nouvel essai du même jeton).
  return res.status(400).json({ error: REJECTION_MESSAGES[reason] ?? DEFAULT_REJECTION, code: "GOOGLE_REJECTED" });
}

// ── Comptes ──────────────────────────────────────────────────────────────────
export const GOOGLE_OTHER_ACCOUNT =
  "Ce compte SunuSanté Famille est déjà lié à un autre compte Google. Connectez-vous avec celui-ci, ou avec votre mot de passe.";
export const GOOGLE_SUB_TAKEN = "Ce compte Google est déjà lié à un autre compte SunuSanté Famille.";
export const SIGNUP_TOKEN_TTL_MS = 15 * 60 * 1000;

// Informations du compte renvoyées au frontend après connexion.
export const sessionUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerified,
  seniorMode: !!user.seniorMode,
});

// Ouvre une session (mêmes cookies et jetons que la connexion par mot de passe).
export async function openSession(res, user) {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  setAuthCookies(res, accessToken, refreshToken);
}

const isUniqueViolation = (error) => error?.code === "23505" || error?.cause?.code === "23505";

// Rattache l'identité Google à un compte existant de MÊME adresse. Google a
// vérifié l'adresse : elle est marquée vérifiée. Le mot de passe existant reste
// valable… SAUF si l'adresse n'avait jamais été vérifiée : ce mot de passe a
// pu être choisi par quelqu'un d'autre qui a inscrit cette adresse à la place
// de sa propriétaire (pré-détournement de compte). Il est alors effacé, avec
// les sessions et liens de vérification en cours, et le nom est repris de
// Google — comme une nouvelle inscription remplace une inscription non
// vérifiée (routes/auth.js). Renvoie le compte à jour, ou null si un autre
// identifiant Google a été lié entre-temps.
export async function linkGoogleAccount(user, identity, req) {
  const wasVerified = user.emailVerified;
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const changes = { googleSub: identity.sub, googleLinkedAt: new Date(), emailVerified: true };
  if (!wasVerified) Object.assign(changes, { passwordHash: null, passwordChangedAt: now, name: identity.name });
  let updated;
  try {
    [updated] = await db
      .update(users)
      .set(changes)
      .where(and(eq(users.id, user.id), isNull(users.googleSub)))
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
  if (!updated) return null;
  if (!wasVerified) {
    await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, user.id));
    await db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));
  }
  await logTechnical({
    category: "auth",
    message: wasVerified ? "Connexion Google ajoutée au compte" : "Connexion Google ajoutée au compte (adresse non vérifiée : ancien mot de passe effacé)",
    metadata: { ...requestMeta(req), userId: user.id },
  });
  await sendGoogleLinkedEmail({ to: updated.email, name: updated.name });
  return updated;
}

// Connexion avec une identité Google vérifiée — règles communes à « Continuer
// avec Google » et à « Accepter avec Google » :
//   1. identifiant Google (sub) connu → ce compte, même si l'adresse Google a
//      changé depuis ;
//   2. sinon, compte de même adresse → liaison automatique (sauf s'il est
//      déjà lié à un AUTRE compte Google) ;
//   3. sinon → AUCUN compte créé : un jeton d'inscription (15 min, usage
//      unique) attend la confirmation de la personne.
// Un compte suspendu reçoit le même refus que la connexion classique.
// Renvoie { user, linked } | { signup } | { status, body }.
export async function signInWithGoogle(identity, req, { invitationId = null } = {}) {
  const [bySub] = await db.select().from(users).where(eq(users.googleSub, identity.sub));
  let user = bySub;
  let linked = false;
  if (!user) {
    const [byEmail] = await db.select().from(users).where(eq(users.email, identity.email));
    if (byEmail) {
      if (byEmail.googleSub) {
        await logTechnical({ level: "warn", category: "auth", message: "Connexion Google refusée : compte lié à un autre compte Google", metadata: { ...requestMeta(req), userId: byEmail.id } });
        return { status: 409, body: { error: GOOGLE_OTHER_ACCOUNT, code: "GOOGLE_OTHER_ACCOUNT" } };
      }
      if (isSuspended(byEmail)) user = byEmail; // refusé juste après, SANS liaison
      else {
        user = await linkGoogleAccount(byEmail, identity, req);
        if (!user) return { status: 409, body: { error: GOOGLE_OTHER_ACCOUNT, code: "GOOGLE_OTHER_ACCOUNT" } };
        linked = true;
      }
    }
  }

  if (user) {
    if (isSuspended(user)) {
      await logTechnical({ level: "warn", category: "auth", message: "Connexion Google refusée : compte suspendu", metadata: { ...requestMeta(req), userId: user.id } });
      return { status: 403, body: { error: suspendedLoginMessage(user), code: "ACCOUNT_SUSPENDED" } };
    }
    return { user, linked };
  }

  const signupToken = generateToken();
  await db.insert(googleSignupTokens).values({
    tokenHash: hashToken(signupToken),
    googleSub: identity.sub,
    email: identity.email,
    name: identity.name,
    invitationId,
    expiresAt: new Date(Date.now() + SIGNUP_TOKEN_TTL_MS),
  });
  return { signup: { needsSignup: true, signupToken, name: identity.name, email: identity.email } };
}

// Création du compte après confirmation (nom, acceptation des conditions).
// Le compte naît VÉRIFIÉ (Google a vérifié l'adresse) et SANS mot de passe.
// Renvoie { user, invitationId } | { status, body }.
export async function completeGoogleSignup({ signupToken, name, accept }, req) {
  if (accept !== true) {
    return { status: 400, body: { error: "Vous devez accepter les conditions d'utilisation et la politique de confidentialité" } };
  }
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (!cleanName || cleanName.length > MAX_NAME_LENGTH) {
    return { status: 400, body: { error: `Nom requis (${MAX_NAME_LENGTH} caractères maximum)` } };
  }
  if (typeof signupToken !== "string" || !signupToken || signupToken.length > 200) {
    return { status: 400, body: { error: "Inscription invalide : recommencez avec le bouton Google" } };
  }
  const [pending] = await db.select().from(googleSignupTokens).where(eq(googleSignupTokens.tokenHash, hashToken(signupToken)));
  if (!pending) return { status: 404, body: { error: "Inscription invalide : recommencez avec le bouton Google" } };
  if (pending.consumedAt) return { status: 409, body: { error: "Cette inscription a déjà été confirmée : connectez-vous avec Google" } };
  if (pending.expiresAt < new Date()) return { status: 410, body: { error: "Cette inscription a expiré : recommencez avec le bouton Google" } };

  // Consommation conditionnelle : deux envois simultanés, un seul passe.
  const [claimed] = await db
    .update(googleSignupTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(googleSignupTokens.id, pending.id), isNull(googleSignupTokens.consumedAt)))
    .returning();
  if (!claimed) return { status: 409, body: { error: "Cette inscription a déjà été confirmée : connectez-vous avec Google" } };

  let user;
  try {
    [user] = await db
      .insert(users)
      .values({
        email: pending.email,
        name: cleanName,
        passwordHash: null,
        emailVerified: true,
        googleSub: pending.googleSub,
        googleLinkedAt: new Date(),
      })
      .returning();
  } catch (error) {
    // Compte créé entre-temps avec cette adresse ou cet identifiant Google.
    if (isUniqueViolation(error)) {
      return { status: 409, body: { error: "Un compte existe déjà : connectez-vous avec le bouton Google" } };
    }
    throw error;
  }
  await logTechnical({ category: "auth", message: "Inscription avec Google", metadata: { ...requestMeta(req), userId: user.id } });
  return { user, invitationId: pending.invitationId };
}
