import { ageOf } from "./kinship.js";
// Vocabulaire commun de l'application — trois notions bien distinctes :
// - Compte : un identifiant de connexion (email + mot de passe). Les parents
//   du foyer sont les administrateurs (administrateur familial et
//   co-administrateur) ; le niveau d'accès des autres comptes est déduit de
//   l'âge par le serveur (lecture seule avant 18 ans, complet ensuite, pas de
//   compte avant 15 ans) ;
// - Membre : une personne du foyer, avec ou sans compte, désignée par son
//   lien de parenté (voir lib/kinship.js) ;
// - Fiche (fiche médicale) : le dossier médical d'un membre. Les rôles
//   Gestionnaire / Relais / Lecteur invité sont des rôles SUR UNE FICHE.

// ---------------------------------------------------------------------------
// Rôle d'un compte dans la famille

// Options des sélecteurs (invitation, changement de rôle). "member" laisse le
// serveur déduire le niveau d'accès de l'âge ; "parent" désigne un
// co-administrateur (réservé à l'administrateur familial).
export const FAMILY_ROLE_OPTIONS = [
  { value: "member", label: "Membre de la famille" },
  { value: "parent", label: "Parent — co-administrateur" },
];

// Explication commune du niveau d'accès selon l'âge
export const AGE_ACCESS_HELP =
  "Le niveau d'accès d'un membre dépend de son âge : lecture seule avant 18 ans, complet ensuite. Pas de compte avant 15 ans.";

// Libellé court du rôle familial d'un compte ; null → membre sans compte.
// ("adult" / "dependent" sont les niveaux effectifs renvoyés par le serveur.)
export function familyRoleLabel(role, isPrimaryAdmin = false) {
  if (!role) return "Sans compte";
  if (role === "parent") return isPrimaryAdmin ? "Administrateur familial" : "Co-administrateur";
  if (role === "dependent") return "Membre adolescent";
  if (role === "adult" || role === "member") return "Membre de la famille";
  return role;
}

// Libellé détaillé du niveau d'accès effectif d'un compte, en clair.
// Ex. "Membre — adolescent, lecture seule (16 ans)".
export function accountLevelLabel(role, isPrimaryAdmin = false, age = null) {
  if (role === "parent") return isPrimaryAdmin ? "Administrateur familial" : "Co-administrateur";
  if (role === "dependent") {
    return `Membre — adolescent, lecture seule${age !== null && age !== undefined ? ` (${age} ans)` : ""}`;
  }
  if (role === "adult" || role === "member") return "Membre — accès complet";
  return familyRoleLabel(role, isPrimaryAdmin);
}

// Libellé à partir de l'objet `account` d'un membre (ou d'une ligne de compte)
export function accountRoleLabel(account) {
  if (!account) return "Sans compte";
  return familyRoleLabel(account.role, account.isPrimaryAdmin);
}

export function familyRoleBadgeVariant(role, isPrimaryAdmin = false) {
  if (!role) return "default";
  if (role === "parent") return isPrimaryAdmin ? "danger" : "warning";
  if (role === "dependent") return "success";
  return "info";
}

// ---------------------------------------------------------------------------
// Statut de la personne (membre)

export const MEMBER_STATUS_OPTIONS = [
  { value: "connecte_autonome", label: "Connecté autonome" },
  { value: "connecte_assiste", label: "Connecté assisté (mode senior)" },
  { value: "adolescent", label: "Adolescent" },
  { value: "mineur_gere", label: "Enfant — dossier tenu par un parent (aucun compte)" },
  { value: "non_connecte", label: "Proche non connecté (village)" },
];

export function memberStatusLabel(status) {
  return MEMBER_STATUS_OPTIONS.find((s) => s.value === status)?.label ?? "Connecté autonome";
}

// Sous-titre d'un membre sans compte, selon son statut
// Ligne « compte » d'un membre sans compte. Avec la date de naissance, un
// enfant de moins de 15 ans est dit « trop jeune » (pas de compte possible).
export function noAccountSubtitle(status, dateOfBirth = null) {
  if (status === "non_connecte") return "Proche non connecté (village)";
  const age = dateOfBirth ? ageOf(dateOfBirth) : null;
  if (status === "mineur_gere" || (age !== null && age < 15)) return "Trop jeune pour un compte : fiche tenue par les parents";
  return "Pas encore de compte";
}

// ---------------------------------------------------------------------------
// Rôles sur une fiche (dossier médical)

export const FICHE_ROLE_OPTIONS = [
  { value: "gestionnaire", label: "Gestionnaire — saisit et gère le dossier" },
  {
    value: "relais",
    label: "Relais — prévient la personne de ses rendez-vous (date, heure, lieu), sans accès au dossier",
  },
  { value: "lecteur_invite", label: "Lecteur invité — consulte le dossier sans le modifier" },
];

const FICHE_ROLE_SHORT = {
  titulaire: "Titulaire",
  gestionnaire: "Gestionnaire",
  relais: "Relais (rendez-vous)",
  lecteur_invite: "Lecteur invité",
};

// Badge court d'un rôle sur une fiche
export function ficheRoleShortLabel(role) {
  return FICHE_ROLE_SHORT[role] ?? role;
}

// Libellé complet (avec description) d'un rôle sur une fiche
export function ficheRoleLongLabel(role) {
  return FICHE_ROLE_OPTIONS.find((r) => r.value === role)?.label ?? ficheRoleShortLabel(role);
}

// ---------------------------------------------------------------------------
// Lien de l'utilisateur courant avec la fiche d'un membre, en phrase explicite.
// `myRole` / `isPrimaryAdmin` : rôle familial de l'utilisateur courant.
export function myRelationSentence(member, { myRole, isPrimaryAdmin } = {}) {
  if (!member) return "";
  if (member.isMine) return "C'est votre fiche : vous en êtes titulaire.";
  switch (member.myDocumentRole) {
    case "gestionnaire":
      return "Vous êtes gestionnaire de sa fiche : vous saisissez et gérez son dossier.";
    case "lecteur_invite":
      return "Vous êtes lecteur invité : vous consultez son dossier sans le modifier.";
    case "relais":
      return "Vous êtes relais : vous le/la prévenez de ses rendez-vous (date, heure et lieu seulement), sans accès à son dossier.";
    default:
      break;
  }
  if (member.access === "full") {
    if (myRole === "parent") {
      return isPrimaryAdmin
        ? "Accès complet en tant qu'administrateur familial."
        : "Accès complet en tant que co-administrateur.";
    }
    return "Accès complet à son dossier.";
  }
  if (member.access === "read") return "Lecture seule.";
  if (member.access === "relay") {
    return "Vous êtes relais : vous le/la prévenez de ses rendez-vous (date, heure et lieu seulement), sans accès à son dossier.";
  }
  return "Vous n'avez pas accès à son dossier.";
}

// Badge court résumant le lien de l'utilisateur avec une fiche
export function myRelationBadge(member) {
  if (!member) return null;
  if (member.isMine) return { label: "Titulaire", variant: "success" };
  if (member.myDocumentRole) {
    const variant = member.myDocumentRole === "relais" ? "warning" : "info";
    return { label: ficheRoleShortLabel(member.myDocumentRole), variant };
  }
  if (member.access === "relay") return { label: ficheRoleShortLabel("relais"), variant: "warning" };
  if (member.access === "read") return { label: "Lecture seule", variant: "info" };
  return null;
}
