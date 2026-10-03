// Liens de parenté du foyer — calcul pur (sans React, sans API navigateur :
// importable tel quel par Node pour un auto-test).
//
// Chaque fiche porte, côté serveur :
// - `gender` : "M" | "F" ;
// - `dateOfBirth` : "AAAA-MM-JJ" ;
// - `kinship` : le lien avec les PARENTS du foyer (les administrateurs) :
//   "parent" | "enfant" | "petit_enfant" | "grand_parent" | "oncle_tante"
//   | "neveu_niece" | "cousin" | "autre" (null = à compléter) ;
// - `kinshipRelatedMemberId` (facultatif) : la personne par qui passe le lien
//   (grand_parent → le parent dont c'est le père/la mère ; oncle_tante → le
//   parent dont c'est le frère/la sœur ; petit_enfant → l'enfant dont c'est
//   l'enfant ; neveu_niece → l'oncle/la tante dont c'est l'enfant).
//
// À partir de ces données, on calcule le lien d'une personne TEL QUE LE VOIT
// celui qui regarde (sa propre fiche). Exemples, pour le foyer Yacine (père),
// Zahra (mère), Yass (fils, 2001), Ibou (fils, 2018), Mamadou (grand-parent,
// père de Yacine), Awa (oncle_tante, sœur de Zahra) :
//   kinshipLabel(Ibou, Yass)    → "Petit frère"
//   kinshipLabel(Yass, Ibou)    → "Grand frère"
//   kinshipLabel(Mamadou, Yacine) → "Père"
//   kinshipLabel(Mamadou, Zahra)  → "Beau-père"
//   kinshipLabel(Awa, Yacine)   → "Belle-sœur"
//   kinshipLabel(Awa, Ibou)     → "Tante"
//   kinshipLabel(Ibou, null)    → "Fils cadet" (point de vue des parents)

// ---------------------------------------------------------------------------
// Âge et catégorie d'âge

// Âge en années révolues à la date `today` ; null si la date est inconnue.
export function ageOf(dateOfBirth, today = new Date()) {
  if (!dateOfBirth) return null;
  const [y, m, d] = String(dateOfBirth).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  let age = today.getFullYear() - y;
  const month = today.getMonth() + 1;
  if (month < m || (month === m && today.getDate() < d)) age -= 1;
  return age < 0 ? null : age;
}

// Catégorie d'âge affichée à côté de l'âge
export function ageCategory(age) {
  if (age === null || age === undefined) return null;
  if (age < 2) return "Bébé";
  if (age < 13) return "Enfant";
  if (age < 18) return "Adolescent";
  if (age < 60) return "Adulte";
  return "Senior";
}

// Sous-titre d'une personne : "8 ans · Enfant", "71 ans · Senior"...
export function memberSubtitle(member) {
  const age = ageOf(member?.dateOfBirth);
  if (age === null) return "Âge à préciser";
  const years = age === 0 ? "Moins d'un an" : `${age} an${age > 1 ? "s" : ""}`;
  return `${years} · ${ageCategory(age)}`;
}

// ---------------------------------------------------------------------------
// Options des formulaires ("parent" n'y figure pas : réservé aux
// administrateurs, fixé par le serveur).

// `related` : le lien passe par une autre personne du foyer, à choisir
// (facultatif) parmi les fiches dont le lien vaut `eligible`.
export const KINSHIP_OPTIONS = [
  { value: "enfant", label: "Enfant des parents" },
  { value: "petit_enfant", label: "Petit-enfant des parents", related: { label: "Enfant de…", eligible: "enfant" } },
  {
    value: "grand_parent",
    label: "Parent d'un des parents (grand-parent)",
    related: { label: "Parent de…", eligible: "parent" },
  },
  {
    value: "oncle_tante",
    label: "Frère ou sœur d'un des parents (oncle / tante)",
    related: { label: "Frère ou sœur de…", eligible: "parent" },
  },
  { value: "neveu_niece", label: "Neveu ou nièce des parents", related: { label: "Enfant de…", eligible: "oncle_tante" } },
  { value: "cousin", label: "Cousin(e) des parents" },
  { value: "autre", label: "Autre proche" },
];

// Description du second sélecteur pour un lien donné, ou null
export function kinshipRelatedSpec(kinship) {
  return KINSHIP_OPTIONS.find((o) => o.value === kinship)?.related ?? null;
}

// Personnes pouvant servir d'intermédiaire pour ce lien (hors `excludeId`)
export function relatedCandidates(kinship, members, excludeId = null) {
  const spec = kinshipRelatedSpec(kinship);
  if (!spec) return [];
  return (members ?? []).filter((m) => m.kinship === spec.eligible && !sameId(m.id, excludeId));
}

// Fiche dont le lien, l'âge ou le sexe reste à renseigner
export function kinshipIncomplete(member) {
  return !member?.kinship || !member?.dateOfBirth || (member?.gender !== "M" && member?.gender !== "F");
}

// ---------------------------------------------------------------------------
// Petits utilitaires internes

function sameId(a, b) {
  return a !== null && a !== undefined && b !== null && b !== undefined && Number(a) === Number(b);
}

// Forme masculine / féminine selon le sexe de la personne désignée
// (sexe inconnu → les deux formes).
function g(target, masc, fem) {
  if (target?.gender === "M") return masc;
  if (target?.gender === "F") return fem;
  return `${masc} / ${fem}`;
}

function findMember(id, allMembers) {
  if (id === null || id === undefined) return null;
  return (allMembers ?? []).find((m) => sameId(m.id, id)) ?? null;
}

// Frère / sœur, précisé par l'âge par rapport à celui qui regarde :
// plus âgé → "Grand frère" / "Grande sœur", plus jeune → "Petit frère" /
// "Petite sœur", même date de naissance → "Frère jumeau" / "Sœur jumelle".
function sibling(target, viewer) {
  const a = target?.dateOfBirth;
  const b = viewer?.dateOfBirth;
  if (!a || !b) return g(target, "Frère", "Sœur");
  if (a === b) return g(target, "Frère jumeau", "Sœur jumelle");
  return a < b ? g(target, "Grand frère", "Grande sœur") : g(target, "Petit frère", "Petite sœur");
}

// Fils / Fille, avec le rang parmi les enfants du foyer quand il y en a au
// moins deux : l'aîné(e) et le/la cadet(te). Ex. "Fils aîné", "Fille cadette".
function childWithRank(target, allMembers) {
  const base = g(target, "Fils", "Fille");
  if (!target?.dateOfBirth) return base;
  const children = (allMembers ?? [])
    .filter((m) => m.kinship === "enfant" && m.dateOfBirth)
    .sort((x, y) => (x.dateOfBirth < y.dateOfBirth ? -1 : x.dateOfBirth > y.dateOfBirth ? 1 : 0));
  if (children.length < 2) return base;
  const first = children[0].dateOfBirth;
  const last = children[children.length - 1].dateOfBirth;
  if (first === last) return base;
  if (target.dateOfBirth === first) return `${base} ${g(target, "aîné", "aînée")}`;
  if (target.dateOfBirth === last) return `${base} ${g(target, "cadet", "cadette")}`;
  return base;
}

// ---------------------------------------------------------------------------
// Repli : le lien vu par les parents du foyer (aucun point de vue précis).
// Ex. "Grand-père (parent de Yacine)", "Tante (sœur de Zahra)".
export function householdKinshipLabel(target, allMembers) {
  const related = findMember(target?.kinshipRelatedMemberId, allMembers);
  switch (target?.kinship) {
    case "parent":
      return "Parent (administrateur)";
    case "enfant":
      return childWithRank(target, allMembers);
    case "petit_enfant":
      return g(target, "Petit-fils", "Petite-fille");
    case "grand_parent":
      return g(target, "Grand-père", "Grand-mère") + (related ? ` (parent de ${related.firstName})` : "");
    case "oncle_tante":
      return (
        g(target, "Oncle", "Tante") + (related ? ` (${g(target, "frère", "sœur")} de ${related.firstName})` : "")
      );
    case "neveu_niece":
      return g(target, "Neveu", "Nièce");
    case "cousin":
      return g(target, "Cousin", "Cousine");
    case "autre":
      return "Proche";
    default:
      return "Lien à préciser";
  }
}

// ---------------------------------------------------------------------------
// Lien de `target` vu par `viewer` (la fiche de celui qui regarde, ou null).
// Renvoie un libellé genré : "Vous", "Grand frère", "Belle-mère", "Tante"...
// Tout cas non couvert retombe sur householdKinshipLabel().
export function kinshipLabel(target, viewer, allMembers) {
  if (!target) return "";
  if (viewer && sameId(target.id, viewer.id)) return "Vous";
  const label = viewer ? viewedLabel(target, viewer) : null;
  return label ?? householdKinshipLabel(target, allMembers);
}

// Lien selon le point de vue de `viewer` ; null → repli.
function viewedLabel(target, viewer) {
  const t = target.kinship;
  // Le lien de `target` passe-t-il par celui qui regarde ?
  const viaViewer = sameId(target.kinshipRelatedMemberId, viewer.id);
  // Celui qui regarde et `target` passent-ils par la même personne ?
  const sameRelated =
    target.kinshipRelatedMemberId != null && sameId(target.kinshipRelatedMemberId, viewer.kinshipRelatedMemberId);

  switch (viewer.kinship) {
    // --- Celui qui regarde est un parent (administrateur) ---
    case "parent":
      switch (t) {
        case "parent":
          return g(target, "Conjoint", "Conjointe");
        case "enfant":
          return null; // "Fils aîné"... : identique au repli (rang parmi les enfants)
        case "petit_enfant":
          return g(target, "Petit-fils", "Petite-fille");
        case "grand_parent":
          // Ex. Mamadou (parent de Yacine) : "Père" pour Yacine, "Beau-père" pour Zahra
          if (viaViewer) return g(target, "Père", "Mère");
          if (target.kinshipRelatedMemberId != null) return g(target, "Beau-père", "Belle-mère");
          return null;
        case "oncle_tante":
          // Ex. Awa (sœur de Zahra) : "Grande sœur"/"Petite sœur" pour Zahra, "Belle-sœur" pour Yacine
          if (viaViewer) return sibling(target, viewer);
          if (target.kinshipRelatedMemberId != null) return g(target, "Beau-frère", "Belle-sœur");
          return g(target, "Oncle", "Tante");
        case "neveu_niece":
          return g(target, "Neveu", "Nièce");
        case "cousin":
          return g(target, "Cousin", "Cousine");
        case "autre":
          return "Proche";
        default:
          return null;
      }

    // --- Celui qui regarde est un enfant du foyer ---
    case "enfant":
      switch (t) {
        case "parent":
          return g(target, "Père", "Mère");
        case "enfant":
          return sibling(target, viewer); // ex. "Petit frère", "Grande sœur"
        case "petit_enfant":
          return viaViewer ? g(target, "Fils", "Fille") : g(target, "Neveu", "Nièce");
        case "grand_parent":
          return g(target, "Grand-père", "Grand-mère");
        case "oncle_tante":
          return g(target, "Oncle", "Tante");
        case "neveu_niece":
        case "cousin":
          return g(target, "Cousin", "Cousine");
        case "autre":
          return "Proche";
        default:
          return null;
      }

    // --- Celui qui regarde est un grand-parent ---
    case "grand_parent":
      switch (t) {
        case "parent":
          // Ex. Mamadou (parent de Yacine) : Yacine = "Fils", Zahra = "Belle-fille"
          if (viewer.kinshipRelatedMemberId == null) return null;
          return sameId(viewer.kinshipRelatedMemberId, target.id)
            ? g(target, "Fils", "Fille")
            : g(target, "Gendre", "Belle-fille");
        case "enfant":
          return g(target, "Petit-fils", "Petite-fille");
        case "petit_enfant":
          return g(target, "Arrière-petit-fils", "Arrière-petite-fille");
        case "oncle_tante":
          // Frère/sœur du même parent : c'est aussi son enfant
          return sameRelated ? g(target, "Fils", "Fille") : null;
        case "grand_parent":
          return sameRelated ? g(target, "Conjoint", "Conjointe") : null;
        default:
          return null;
      }

    // --- Celui qui regarde est un oncle / une tante ---
    case "oncle_tante":
      switch (t) {
        case "parent":
          // Ex. Awa (sœur de Zahra) : Zahra = "Grande sœur", Yacine = "Beau-frère"
          if (viewer.kinshipRelatedMemberId == null) return null;
          return sameId(viewer.kinshipRelatedMemberId, target.id)
            ? sibling(target, viewer)
            : g(target, "Beau-frère", "Belle-sœur");
        case "enfant":
          return g(target, "Neveu", "Nièce");
        case "grand_parent":
          return sameRelated ? g(target, "Père", "Mère") : null;
        case "oncle_tante":
          return sameRelated ? sibling(target, viewer) : null;
        case "neveu_niece":
          return viaViewer ? g(target, "Fils", "Fille") : null;
        default:
          return null;
      }

    // --- Celui qui regarde est un petit-enfant ---
    case "petit_enfant":
      switch (t) {
        case "parent":
          return g(target, "Grand-père", "Grand-mère");
        case "enfant":
          return sameId(viewer.kinshipRelatedMemberId, target.id) ? g(target, "Père", "Mère") : g(target, "Oncle", "Tante");
        case "grand_parent":
          return g(target, "Arrière-grand-père", "Arrière-grand-mère");
        case "petit_enfant":
          return sameRelated ? sibling(target, viewer) : g(target, "Cousin", "Cousine");
        default:
          return null;
      }

    default:
      return null;
  }
}
