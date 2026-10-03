// Règles d'âge des comptes (spécification §2.3, §9.6) et liens de parenté.

export const ACCOUNT_MIN_AGE = 15; // en dessous : pas de compte, fiche tenue par les parents
export const ADULT_AGE = 18; // en dessous : compte adolescent, lecture seule

export const KINSHIPS = ["parent", "enfant", "petit_enfant", "grand_parent", "oncle_tante", "neveu_niece", "cousin", "autre"];
export const GENDERS = ["M", "F"];

export function ageOn(dateOfBirth, now = new Date()) {
  if (!dateOfBirth) return null;
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
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
