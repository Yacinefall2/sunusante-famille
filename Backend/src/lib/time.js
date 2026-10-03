// Fuseau de référence de l'application (Sénégal par défaut). Les dates sont
// stockées en UTC ; ce fuseau sert à savoir « quel jour on est » et à placer
// une heure de prise (08:00) au bon instant.
export const APP_TIMEZONE = process.env.APP_TIMEZONE || "Africa/Dakar";

function parts(date, timeZone = APP_TIMEZONE) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

// Date du jour (AAAA-MM-JJ) dans le fuseau de l'application.
export function localDate(date = new Date(), timeZone = APP_TIMEZONE) {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

// Ajoute n jours à une date AAAA-MM-JJ.
export function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Instant UTC correspondant à « date à HH:MM » dans le fuseau de l'application.
export function zonedTime(isoDate, hhmm, timeZone = APP_TIMEZONE) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = parts(new Date(guess), timeZone);
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(guess - (asIfUtc - guess));
}

// « jeudi 12 novembre à 10:00 » dans le fuseau de l'application.
export function formatDateTime(date, timeZone = APP_TIMEZONE) {
  const d = new Intl.DateTimeFormat("fr-FR", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(date);
  const t = new Intl.DateTimeFormat("fr-FR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
  return `${d} à ${t}`;
}

export function formatDate(isoDate) {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(
    new Date(`${isoDate}T00:00:00Z`)
  );
}
