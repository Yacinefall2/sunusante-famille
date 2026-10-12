// Limite des tentatives de connexion par adresse courriel : après
// MAX_FAILURES échecs dans la fenêtre, la connexion est refusée jusqu'à la
// fin de celle-ci (même avec le bon mot de passe). Compteurs en mémoire :
// suffisant pour un seul serveur, remis à zéro à son redémarrage.
export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;

const failures = new Map(); // email -> { count, resetAt }

function entry(email, now) {
  const e = failures.get(email);
  if (e && e.resetAt <= now) {
    failures.delete(email);
    return null;
  }
  return e ?? null;
}

// Minutes restantes avant de pouvoir réessayer, ou 0 si la connexion est permise.
export function lockedMinutes(email, now = Date.now()) {
  const e = entry(email, now);
  return e && e.count >= MAX_FAILURES ? Math.ceil((e.resetAt - now) / 60000) : 0;
}

export function recordFailure(email, now = Date.now()) {
  const e = entry(email, now) ?? { count: 0, resetAt: now + WINDOW_MS };
  e.count += 1;
  failures.set(email, e);
}

export function clearFailures(email) {
  failures.delete(email);
}

// Pour les tests.
export function resetLoginThrottle() {
  failures.clear();
}
