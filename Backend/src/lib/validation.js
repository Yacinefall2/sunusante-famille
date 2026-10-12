import { APP_TIMEZONE, zonedTime } from "./time.js";

// ── Validation commune des entrées ───────────────────────────────────────────
// Toute valeur venue du navigateur est vérifiée avant d'atteindre la base :
// un identifiant ou une date mal formés donnent une erreur 400 avec un
// message clair, jamais une erreur PostgreSQL (500).

const MAX_INT = 2147483647; // plus grand entier d'une colonne PostgreSQL « integer »

// Identifiant : entier strictement positif (nombre ou chaîne de chiffres),
// dans les limites d'une colonne integer. Sinon null.
export function parseId(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value <= MAX_INT ? value : null;
  }
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n > 0 && n <= MAX_INT ? n : null;
}

export const INVALID_ID = "Identifiant invalide";

// Date du calendrier AAAA-MM-JJ réellement existante : « 2026-02-30 » est
// refusée (la date relue doit être identique à celle écrite).
export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export const INVALID_DATE = "Date invalide (format AAAA-MM-JJ attendu)";

// Heure HH:MM, de 00:00 à 23:59.
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isTime = (value) => typeof value === "string" && TIME_PATTERN.test(value);

// Date et heure d'un rendez-vous. Le formulaire envoie « AAAA-MM-JJTHH:MM »
// sans fuseau : c'est l'heure locale de l'application (APP_TIMEZONE), pas
// celle du serveur. Une chaîne qui porte déjà son fuseau (Z ou ±HH:MM) est
// prise telle quelle. Renvoie une Date, ou null si la valeur est invalide.
const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const ZONED_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseDateTime(value, timeZone = APP_TIMEZONE) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const local = LOCAL_DATETIME.exec(value.trim());
  if (local) {
    const [, day, hh, mm, ss = "0", ms = "0"] = local;
    if (!isIsoDate(day) || !isTime(`${hh}:${mm}`) || Number(ss) > 59) return null;
    return new Date(zonedTime(day, `${hh}:${mm}`, timeZone).getTime() + Number(ss) * 1000 + Number(ms.padEnd(3, "0")));
  }
  if (!ZONED_DATETIME.test(value.trim())) return null;
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime()) || !isIsoDate(value.trim().slice(0, 10))) return null;
  return date;
}

export const INVALID_DATETIME = "Date et heure invalides (format AAAA-MM-JJTHH:MM attendu)";

// Longueurs maximales (alignées sur les varchar de db/schema.js). `fields` :
// liste de [valeur, longueur maximale, libellé]. Renvoie le premier message
// d'erreur, ou null. Une valeur absente (null/undefined) est acceptée.
export function tooLong(fields) {
  for (const [value, max, label] of fields) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return `${label} : texte attendu`;
    if (value.length > max) return `${label} : ${max} caractères maximum`;
  }
  return null;
}
