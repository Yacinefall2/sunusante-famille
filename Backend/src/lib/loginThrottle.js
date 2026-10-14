import { WindowCounter, resetAllRateLimits } from "./rateLimit.js";
import { logTechnicalLater, truncateIp } from "./technicalLog.js";

// Limite des tentatives de mot de passe (connexion, et vérification du mot de
// passe actuel dans « Mon compte »). Trois compteurs, en mémoire et bornés
// (voir lib/rateLimit.js) :
//   - par adresse ET adresse IP : MAX_FAILURES échecs bloquent cette adresse
//     depuis cette IP, même avec le bon mot de passe ;
//   - par adresse, toutes IP confondues : MAX_FAILURES_PER_EMAIL échecs
//     bloquent l'adresse partout (attaque répartie sur plusieurs machines) ;
//   - par IP, toutes adresses confondues : MAX_FAILURES_PER_IP échecs
//     bloquent l'IP (un même mot de passe essayé sur beaucoup de comptes,
//     « password spraying »).
// Le blocage dure LOCK_MS à partir du moment où il est atteint, sans être
// prolongé par les tentatives suivantes : un attaquant isolé ne bloque que
// lui-même, ne peut pas bloquer un compte indéfiniment, et la personne garde
// « Mot de passe oublié » (qui remet les compteurs de son adresse à zéro).
export const MAX_FAILURES = 5;
export const MAX_FAILURES_PER_EMAIL = 20;
export const MAX_FAILURES_PER_IP = 30;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;

const options = { windowMs: WINDOW_MS, lockMs: LOCK_MS, maxEntries: 20000 };
const byEmailAndIp = new WindowCounter({ ...options, max: MAX_FAILURES });
const byEmail = new WindowCounter({ ...options, max: MAX_FAILURES_PER_EMAIL });
const byIp = new WindowCounter({ ...options, max: MAX_FAILURES_PER_IP });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_LENGTH = 255;

// Adresse courriel normalisée (minuscules, sans espaces autour), ou null si
// ce n'est pas une adresse plausible. Vérifié AVANT tout traitement : une
// valeur arbitraire (objet, chaîne géante) n'entre jamais dans les compteurs
// ni dans une requête SQL.
export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.toLowerCase().trim();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) return null;
  return email;
}

const ipKey = (ip) => ip || "inconnue";
const pairKey = (email, ip) => `${email}|${ipKey(ip)}`;

// Minutes restantes avant de pouvoir réessayer, ou 0 si la tentative est permise.
export function lockedMinutes(email, ip, now = Date.now()) {
  const ms = Math.max(
    byEmailAndIp.blockedMs(pairKey(email, ip), now),
    byEmail.blockedMs(email, now),
    byIp.blockedMs(ipKey(ip), now)
  );
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

export function recordFailure(email, ip, now = Date.now()) {
  const wasLocked = lockedMinutes(email, ip, now) > 0;
  byEmailAndIp.add(pairKey(email, ip), now);
  byEmail.add(email, now);
  byIp.add(ipKey(ip), now);
  // Journal technique (UC-53) : blocage déclenché (adresse IP tronquée,
  // jamais l'adresse courriel).
  if (!wasLocked && lockedMinutes(email, ip, now) > 0) {
    logTechnicalLater({ level: "warn", category: "security", message: "Tentatives de connexion bloquées (trop d'échecs)", metadata: { ip: truncateIp(ip), limiter: "connexion" } });
  }
}

// Échecs comptés pour cette adresse (toutes IP confondues) dans la fenêtre en cours.
export function failureCount(email, now = Date.now()) {
  return byEmail.count(email, now);
}

// Tentative réussie : les compteurs de cette adresse repartent de zéro. Celui
// de l'IP est conservé (un attaquant qui possède un compte ne doit pas pouvoir
// effacer ses essais sur les autres en se connectant au sien).
export function clearFailures(email, ip) {
  byEmailAndIp.delete(pairKey(email, ip));
  byEmail.delete(email);
}

// Mot de passe réinitialisé par le lien reçu : l'adresse est débloquée depuis
// toutes les IP.
export function clearEmail(email) {
  byEmail.delete(email);
  byEmailAndIp.deleteWhere((key) => key.startsWith(`${email}|`));
}

export const tooManyAttemptsMessage = (minutes) =>
  `Trop de tentatives. Réessayez dans ${minutes} minute${minutes > 1 ? "s" : ""}, ou utilisez « Mot de passe oublié ».`;

// Pour les tests (resetDatabase l'appelle entre deux tests) : remet à zéro
// ces compteurs ET les limites de requêtes par IP de lib/rateLimit.js.
export function resetLoginThrottle() {
  resetAllRateLimits();
}
