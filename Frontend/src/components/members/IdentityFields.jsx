import { Input, Select } from "../ui/Input";
import { KINSHIP_OPTIONS, kinshipRelatedSpec, relatedCandidates } from "../../lib/kinship";

// Valeurs par défaut des champs d'identité (obligatoires côté serveur)
export const IDENTITY_FIELDS_DEFAULTS = {
  dateOfBirth: "",
  gender: "",
  kinship: "",
  kinshipRelatedMemberId: "",
};

// Contrôle avant envoi : renvoie un message d'erreur clair, ou null.
// `isAdmin` : fiche d'un administrateur (lien "parent" fixé par le serveur).
export function identityError(form, { isAdmin = false } = {}) {
  const missing = [];
  if (!form.dateOfBirth) missing.push("la date de naissance");
  if (form.gender !== "M" && form.gender !== "F") missing.push("le sexe");
  if (!isAdmin && !form.kinship) missing.push("le lien avec les parents du foyer");
  if (missing.length === 0) return null;
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} et ${missing[missing.length - 1]}` : missing[0];
  return `Merci d'indiquer ${list}.`;
}

// Corps de requête pour les champs d'identité (lien omis pour un administrateur)
export function identityPayload(form, { isAdmin = false } = {}) {
  const payload = { dateOfBirth: form.dateOfBirth, gender: form.gender };
  if (!isAdmin) {
    payload.kinship = form.kinship;
    payload.kinshipRelatedMemberId =
      kinshipRelatedSpec(form.kinship) && form.kinshipRelatedMemberId ? Number(form.kinshipRelatedMemberId) : null;
  }
  return payload;
}

// Champs d'identité communs aux formulaires de fiche : date de naissance,
// sexe et lien avec les parents du foyer (avec, si besoin, la personne par
// qui passe ce lien). Pour la fiche d'un administrateur, le lien est fixe.
// `onChange(key, value)` ; `excludeId` : la fiche en cours de modification.
export function IdentityFields({ form, onChange, members = [], excludeId = null, isAdmin = false }) {
  const spec = kinshipRelatedSpec(form.kinship);
  const candidates = relatedCandidates(form.kinship, members, excludeId);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Input
          label="Date de naissance *"
          type="date"
          value={form.dateOfBirth}
          onChange={(e) => onChange("dateOfBirth", e.target.value)}
        />
        <Select label="Sexe *" value={form.gender} onChange={(e) => onChange("gender", e.target.value)}>
          <option value="">Choisir</option>
          <option value="M">Homme</option>
          <option value="F">Femme</option>
        </Select>
      </div>

      {isAdmin ? (
        <p className="text-sm text-gray-600 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2">
          Lien : <strong>Parent (administrateur du foyer)</strong>
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select
            label="Lien avec les parents du foyer *"
            value={form.kinship}
            onChange={(e) => {
              onChange("kinship", e.target.value);
              onChange("kinshipRelatedMemberId", "");
            }}
          >
            <option value="">Choisir un lien</option>
            {KINSHIP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {spec && (
            <Select
              label={spec.label}
              value={form.kinshipRelatedMemberId ?? ""}
              onChange={(e) => onChange("kinshipRelatedMemberId", e.target.value)}
            >
              <option value="">Je ne sais pas / pas dans l&apos;application</option>
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.firstName} {m.lastName}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}
    </div>
  );
}
