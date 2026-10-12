import { APP_TIMEZONE, localDate } from "./time.js";

// Règles d'âge des comptes (spécification §2.3, §9.6) et liens de parenté.

export const ACCOUNT_MIN_AGE = 15; // en dessous : pas de compte, fiche tenue par les parents
export const ADULT_AGE = 18; // en dessous : compte adolescent, lecture seule

export const KINSHIPS = ["parent", "enfant", "petit_enfant", "grand_parent", "oncle_tante", "neveu_niece", "cousin", "autre"];
export const GENDERS = ["M", "F"];

// Âge révolu au jour `now` DANS LE FUSEAU DE L'APPLICATION (et non en UTC) :
// l'anniversaire commence à minuit heure locale.
export function ageOn(dateOfBirth, now = new Date(), timeZone = APP_TIMEZONE) {
  if (!dateOfBirth) return null;
  const [by, bm, bd] = String(dateOfBirth).slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = localDate(now, timeZone).split("-").map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

// Rôle effectif d'un compte : les parents (administrateurs) le restent ;
// pour les autres, c'est l'âge de leur fiche qui décide — adolescent (lecture
// seule) avant 18 ans, adulte ensuite. Le passage se fait à l'anniversaire,
// sans intervention. Sans date de naissance connue, le rôle enregistré vaut.
export function effectiveRole(storedRole, dateOfBirth, now = new Date()) {
  if (storedRole === "parent") return "parent";
  const age = ageOn(dateOfBirth, now);
  if (age === null) return storedRole;
  return age < ADULT_AGE ? "dependent" : "adult";
}

// Statut (Axe 3) d'une fiche une fois reliée à un compte : « adolescent »
// pour un compte de moins de 18 ans, sinon connecté (on garde « assisté » si
// la fiche l'était déjà).
export function statusForLinkedFiche(role, dateOfBirth, currentStatus) {
  if (effectiveRole(role, dateOfBirth) === "dependent") return "adolescent";
  return currentStatus === "connecte_assiste" ? "connecte_assiste" : "connecte_autonome";
}

// Message commun : un mineur n'est jamais administrateur du foyer (§2.3).
export const MINOR_PARENT_ERROR = `Un compte de moins de ${ADULT_AGE} ans ne peut pas être parent (administrateur) du foyer`;
export const UNDER_MIN_AGE_ERROR = `Moins de ${ACCOUNT_MIN_AGE} ans : pas de compte personnel, la fiche est tenue par les parents`;
