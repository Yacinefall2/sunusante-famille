// Vocabulaire commun de l'application — trois notions bien distinctes :
// - Compte : un identifiant de connexion (email + mot de passe), avec un rôle
//   dans la famille (administrateur, co-administrateur, adulte, adolescent) ;
// - Membre : une personne du foyer, avec ou sans compte ;
// - Fiche (fiche médicale) : le dossier médical d'un membre. Les rôles
//   Gestionnaire / Relais / Lecteur invité sont des rôles SUR UNE FICHE.

// ---------------------------------------------------------------------------
// Rôle d'un compte dans la famille

// Options des sélecteurs (attribution / invitation). "parent" désigne un
// co-administrateur : l'administrateur familial est le créateur de la famille.
export const FAMILY_ROLE_OPTIONS = [
  { value: "parent", label: "Co-administrateur" },
  { value: "adult", label: "Adulte" },
  { value: "dependent", label: "Adolescent" },
];

// Libellé du rôle familial d'un compte ; null → membre sans compte.
export function familyRoleLabel(role, isPrimaryAdmin = false) {
  if (!role) return "Sans compte";
  if (role === "parent") return isPrimaryAdmin ? "Administrateur familial" : "Co-administrateur";
  if (role === "adult") return "Adulte";
  if (role === "dependent") return "Adolescent";
  return role;
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
export function noAccountSubtitle(status) {
  if (status === "mineur_gere") return "Enfant — dossier tenu par un parent";
  if (status === "non_connecte") return "Proche non connecté (village)";
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
