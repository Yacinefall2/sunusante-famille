import { APP_TIMEZONE } from "./time.js";

// ── État de suspension d'un compte (UC-52) — fonctions pures, sans accès à la
// base : utilisées par requireAuth, la connexion et le moteur de rappels.

// Suspendu maintenant ? Une suspension dont la date de fin est passée ne
// compte plus, même avant que le worker ne l'ait levée.
export function isSuspended(user, now = new Date()) {
  if (!user?.suspendedAt) return false;
  return !user.suspendedUntil || new Date(user.suspendedUntil) > now;
}

// « 12/11/2026 à 10:00 » dans le fuseau de l'application.
export function formatSuspensionDate(date) {
  const d = new Date(date);
  const day = new Intl.DateTimeFormat("fr-FR", { timeZone: APP_TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("fr-FR", { timeZone: APP_TIMEZONE, hour: "2-digit", minute: "2-digit" }).format(d);
  return `${day} à ${time}`;
}

export const suspensionEnd = (user) =>
  user.suspendedUntil ? `jusqu'au ${formatSuspensionDate(user.suspendedUntil)}` : "jusqu'à nouvel ordre";

// Message affiché à la connexion — seulement après un mot de passe correct.
export function suspendedLoginMessage(user) {
  // Le motif saisi par le support se termine souvent déjà par un point.
  const motif = user.suspensionReason?.trim().replace(/[.!?…]+$/, "");
  const reason = motif ? ` Motif : ${motif}.` : "";
  return (
    `Votre compte est suspendu ${suspensionEnd(user)}.${reason} ` +
    "Pour contester : répondez au courriel reçu, ou contactez le support depuis « Je n'arrive plus à accéder à mon compte »."
  );
}
