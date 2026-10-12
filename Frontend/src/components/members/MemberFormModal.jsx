import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input, Textarea, Select } from "../ui/Input";
import { CONTACT_FIELDS_DEFAULTS, contactFieldsFromMember, MemberContactFields } from "./MemberContactFields";
import { useFamily } from "../../context/FamilyContext";
import { AVATAR_COLORS, BLOOD_TYPES } from "../../lib/utils";
import { MEMBER_STATUS_OPTIONS } from "../../lib/roles";
import { IDENTITY_FIELDS_DEFAULTS, IdentityFields, identityError, identityPayload } from "./IdentityFields";
import { ConsentAttestation, consentApplies } from "./ConsentAttestation";
import toast from "react-hot-toast";

const defaultForm = {
  firstName: "",
  lastName: "",
  ...IDENTITY_FIELDS_DEFAULTS,
  bloodType: "",
  allergies: "",
  notes: "",
  avatarColor: AVATAR_COLORS[0],
  status: "connecte_autonome",
  ...CONTACT_FIELDS_DEFAULTS,
};

// Formulaire d'ajout d'un membre (création de la personne ET de sa fiche
// médicale, via POST /api/members) ou de modification d'une fiche existante.
// `editing` : membre à modifier, ou null pour un ajout.
//
// Ajout d'un proche majeur (ou dont la date de naissance n'est pas connue) :
// la fiche n'a pas de compte, son accord oral doit être attesté AVANT
// l'envoi (UC-29, écran n°6). Le bouton devient « Continuer », puis l'écran
// d'engagement s'affiche ; la fiche est envoyée avec l'attestation.
export function MemberFormModal({ open, onClose, editing = null, onSaved }) {
  const { selectedFamily, members, reloadMembers } = useFamily();
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  // "form" : saisie de la fiche ; "consent" : écran d'engagement
  const [step, setStep] = useState("form");
  const [consentError, setConsentError] = useState("");

  // Réinitialise le formulaire à chaque ouverture
  useEffect(() => {
    if (!open) return;
    setStep("form");
    setConsentError("");
    if (editing) {
      setForm({
        firstName: editing.firstName,
        lastName: editing.lastName,
        dateOfBirth: editing.dateOfBirth ?? "",
        gender: editing.gender === "M" || editing.gender === "F" ? editing.gender : "",
        kinship: editing.kinship ?? "",
        kinshipRelatedMemberId: editing.kinshipRelatedMemberId ? String(editing.kinshipRelatedMemberId) : "",
        bloodType: editing.bloodType ?? "",
        allergies: editing.allergies ?? "",
        notes: editing.notes ?? "",
        avatarColor: editing.avatarColor ?? AVATAR_COLORS[0],
        status: editing.status ?? "connecte_autonome",
        ...contactFieldsFromMember(editing),
      });
    } else {
      setForm({ ...defaultForm, avatarColor: AVATAR_COLORS[members.length % AVATAR_COLORS.length] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const f = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  // Fiche d'un administrateur : le lien "parent" est fixé par le serveur
  const isAdminFiche = !!editing && (editing.account?.role === "parent" || editing.kinship === "parent");

  // Création d'une fiche de proche majeur (ou d'âge inconnu) : attestation requise.
  const needsConsent = !editing && consentApplies(form.dateOfBirth);

  const validate = () => {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      toast.error("Prénom et nom sont requis");
      return false;
    }
    const identityMsg = identityError(form, { isAdmin: isAdminFiche });
    if (identityMsg) {
      toast.error(identityMsg);
      return false;
    }
    return true;
  };

  // « Ajouter » / « Continuer » : enchaîne sur l'engagement si nécessaire.
  const next = () => {
    if (!validate()) return;
    if (needsConsent) {
      setConsentError("");
      setStep("consent");
    } else {
      save();
    }
  };

  const save = async (consent = null) => {
    if (!validate()) return;
    // Les champs d'identité sont envoyés via identityPayload (lien omis pour un administrateur)
    const { kinship: _k, kinshipRelatedMemberId: _r, ...rest } = form;
    const body = { ...rest, ...identityPayload(form, { isAdmin: isAdminFiche }), ...(consent ? { consent } : {}) };
    setSaving(true);
    try {
      const res = await fetch("/api/members", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { id: editing.id, ...body } : { familyId: selectedFamily.id, ...body }),
      });
      if (res.ok) {
        toast.success(editing ? "Fiche modifiée !" : "Membre ajouté et fiche créée !");
        onClose();
        await reloadMembers();
        onSaved?.();
      } else {
        const err = await res.json().catch(() => ({}));
        const message = err.error || (editing ? "Erreur lors de la modification" : "Erreur lors de l'ajout");
        if (String(err.code ?? "").startsWith("CONSENT_")) {
          // Attestation refusée par le serveur : on reste (ou on revient) sur l'engagement.
          setConsentError(message);
          setStep("consent");
        } else {
          toast.error(message);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        editing
          ? `Modifier la fiche de ${editing.firstName}`
          : step === "consent"
            ? `Accord de ${form.firstName.trim()} ${form.lastName.trim()}`
            : "Ajouter un membre"
      }
      size="lg"
    >
      {step === "consent" ? (
        <div className="space-y-4">
          <p className="text-xs font-semibold text-teal-700 uppercase tracking-wide">Étape 2 sur 2 — Engagement</p>
          <ConsentAttestation
            member={{ firstName: form.firstName.trim(), lastName: form.lastName.trim() }}
            onSubmit={(consent) => save(consent)}
            onBack={() => setStep("form")}
            backLabel="Retour à la fiche"
            submitting={saving}
            error={consentError}
          />
        </div>
      ) : (
      <div className="space-y-4">
        {needsConsent && (
          <p className="text-xs font-semibold text-teal-700 uppercase tracking-wide">Étape 1 sur 2 — La fiche</p>
        )}
        {!editing && (
          <p className="text-sm text-gray-600 bg-teal-50 border border-teal-100 rounded-xl px-3 py-2">
            Ajoute une personne du foyer (avec ou sans compte) et crée sa fiche médicale.
          </p>
        )}

        {/* Couleur du profil */}
        <div>
          <label className="text-sm font-semibold text-gray-700 block mb-2">Couleur du profil</label>
          <div className="flex gap-2 flex-wrap">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setForm((p) => ({ ...p, avatarColor: color }))}
                className="w-8 h-8 rounded-full border-4 transition-all"
                style={{
                  backgroundColor: color,
                  borderColor: form.avatarColor === color ? color : "transparent",
                  boxShadow: form.avatarColor === color ? `0 0 0 2px white, 0 0 0 4px ${color}` : "none",
                }}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input label="Prénom *" placeholder="Marie" value={form.firstName} onChange={f("firstName")} />
          <Input label="Nom *" placeholder="Dupont" value={form.lastName} onChange={f("lastName")} />
        </div>

        <IdentityFields
          form={form}
          onChange={(key, value) => setForm((p) => ({ ...p, [key]: value }))}
          members={members}
          excludeId={editing?.id ?? null}
          isAdmin={isAdminFiche}
        />

        <Select label="Groupe sanguin" value={form.bloodType} onChange={f("bloodType")}>
          <option value="">Non connu</option>
          {BLOOD_TYPES.map((bt) => (
            <option key={bt} value={bt}>
              {bt}
            </option>
          ))}
        </Select>

        <Select label="Statut de la personne" value={form.status} onChange={f("status")}>
          {MEMBER_STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>

        <Textarea label="Allergies connues" placeholder="Pénicilline, arachides..." value={form.allergies} onChange={f("allergies")} />
        <Textarea label="Notes médicales" placeholder="Antécédents, conditions chroniques..." value={form.notes} onChange={f("notes")} />

        <div className="pt-2 border-t border-gray-100">
          <MemberContactFields form={form} onChange={(key, value) => setForm((p) => ({ ...p, [key]: value }))} />
        </div>

        <div className="flex gap-3 pt-2">
          <Button variant="ghost" onClick={onClose} className="flex-1">
            Annuler
          </Button>
          <Button onClick={editing ? () => save() : next} loading={saving} className="flex-1">
            {editing ? "Enregistrer" : needsConsent ? "Continuer" : "Ajouter"}
          </Button>
        </div>
        {needsConsent && (
          <p className="text-xs text-gray-500 text-center">
            Personne majeure sans compte : vous attesterez ensuite avoir obtenu son accord oral.
          </p>
        )}
      </div>
      )}
    </Modal>
  );
}
