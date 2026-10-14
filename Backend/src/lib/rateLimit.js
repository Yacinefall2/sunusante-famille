// Compteurs en mémoire à fenêtre fixe, bornés : base commune de la limite des
// tentatives de connexion (lib/loginThrottle.js) et de la limitation des
// requêtes par adresse IP (routes publiques et d'authentification).
//
// En mémoire : suffisant pour un seul serveur, remis à zéro à son
// redémarrage. Bornés : les entrées expirées sont purgées régulièrement et,
// au-delà de maxEntries, les plus anciennes sont oubliées — un afflux de clés
// différentes (adresses IP, courriels inventés) ne peut pas saturer la mémoire.

import { logTechnicalLater, requestMeta } from "./technicalLog.js";

const PURGE_INTERVAL_MS = 60 * 1000;

// Tous les compteurs créés, pour pouvoir les vider d'un coup (tests).
const registry = new Set();

export class WindowCounter {
  // max événements par fenêtre de windowMs ; une fois max atteint, la clé est
  // bloquée pendant lockMs (durée FIXE à partir du blocage : les tentatives
  // faites pendant le blocage ne le prolongent pas).
  constructor({ windowMs, max, lockMs = windowMs, maxEntries = 10000 }) {
    this.windowMs = windowMs;
    this.max = max;
    this.lockMs = lockMs;
    this.maxEntries = maxEntries;
    this.entries = new Map(); // clé -> { count, windowEnd, lockedUntil }
    this.lastPurge = 0;
    registry.add(this);
  }

  #current(key, now) {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.lockedUntil > now) return e;
    // Blocage terminé ou fenêtre écoulée : on repart de zéro.
    if (e.lockedUntil || e.windowEnd <= now) {
      this.entries.delete(key);
      return null;
    }
    return e;
  }

  #purge(now) {
    if (now - this.lastPurge < PURGE_INTERVAL_MS && this.entries.size < this.maxEntries) return;
    this.lastPurge = now;
    for (const [key, e] of this.entries) {
      if (e.lockedUntil <= now && e.windowEnd <= now) this.entries.delete(key);
    }
    // Toujours trop d'entrées : on oublie les plus anciennes (ordre d'insertion).
    if (this.entries.size >= this.maxEntries) {
      const target = Math.floor(this.maxEntries * 0.9);
      for (const key of this.entries.keys()) {
        if (this.entries.size <= target) break;
        this.entries.delete(key);
      }
    }
  }

  // Millisecondes restantes de blocage pour cette clé, ou 0.
  blockedMs(key, now = Date.now()) {
    const e = this.#current(key, now);
    return e && e.lockedUntil > now ? e.lockedUntil - now : 0;
  }

  // Compte un événement. Sans effet pendant un blocage (non cumulatif).
  add(key, now = Date.now()) {
    this.#purge(now);
    if (this.blockedMs(key, now) > 0) return;
    let e = this.#current(key, now);
    if (!e) {
      e = { count: 0, windowEnd: now + this.windowMs, lockedUntil: 0 };
      this.entries.set(key, e);
    }
    e.count += 1;
    if (e.count >= this.max) e.lockedUntil = now + this.lockMs;
  }

  // Événements comptés pour cette clé dans la fenêtre (ou le blocage) en cours.
  count(key, now = Date.now()) {
    return this.#current(key, now)?.count ?? 0;
  }

  delete(key) {
    this.entries.delete(key);
  }

  deleteWhere(predicate) {
    for (const key of this.entries.keys()) if (predicate(key)) this.entries.delete(key);
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
    this.lastPurge = 0;
  }
}

// Middleware Express : au plus `max` requêtes par adresse IP et par fenêtre.
// L'adresse est req.ip, qui tient compte de X-Forwarded-For posé par nginx
// (app.set("trust proxy", 1) dans app.js).
export function ipRateLimit({ windowMs, max, message, name = "ip" }) {
  const counter = new WindowCounter({ windowMs, max: max + 1, lockMs: windowMs });
  const middleware = (req, res, next) => {
    const key = req.ip || "inconnue";
    const wasBlocked = counter.blockedMs(key) > 0;
    counter.add(key);
    const blocked = counter.blockedMs(key);
    // Journal technique (UC-53) : le déclenchement du limiteur, une fois par
    // blocage (pas à chaque requête refusée ensuite).
    if (blocked > 0 && !wasBlocked) {
      logTechnicalLater({ level: "warn", category: "security", message: "Limite de requêtes atteinte", metadata: { ...requestMeta(req), limiter: name } });
    }
    if (blocked > 0) {
      res.set("Retry-After", String(Math.ceil(blocked / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
  middleware.counter = counter;
  return middleware;
}

// Pour les tests : remet tous les compteurs à zéro.
export function resetAllRateLimits() {
  for (const counter of registry) counter.clear();
}
