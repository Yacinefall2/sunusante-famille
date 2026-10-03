import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input, Textarea, Select } from "../ui/Input";
import { CONTACT_FIELDS_DEFAULTS, contactFieldsFromMember, MemberContactFields } from "./MemberContactFields";
import { useFamily } from "../../context/FamilyContext";
import { AVATAR_COLORS, BLOOD_TYPES } from "../../lib/utils";
import { MEMBER_STATUS_OPTIONS } from "../../lib/roles";
import toast from "react-hot-toast";

const defaultForm = {
  firstName: "",
  lastName: "",
  dateOfBirth: "",
  gender: "",
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
export function MemberFormModal({ open, onClose, editing = null, onSaved }) {
  const { selectedFamily, members, reloadMembers } = useFamily();
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);

  // Réinitialise le formulaire à chaque ouverture
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        firstName: editing.firstName,
        lastName: editing.lastName,
        dateOfBirth: editing.dateOfBirth ?? "",
        gender: editing.gender ?? "",
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

  const save = async () => {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      toast.error("Prénom et nom sont requis");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/members", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { id: editing.id, ...form } : { familyId: selectedFamily.id, ...form }),
      });
      if (res.ok) {
        toast.success(editing ? "Fiche modifiée !" : "Membre ajouté et fiche créée !");
        onClose();
        await reloadMembers();
        onSaved?.();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || (editing ? "Erreur lors de la modification" : "Erreur lors de l'ajout"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Modifier la fiche de ${editing.firstName}` : "Ajouter un membre"}
      size="lg"
    >
      <div className="space-y-4">
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

        <div className="grid grid-cols-2 gap-4">
          <Input label="Date de naissance" type="date" value={form.dateOfBirth} onChange={f("dateOfBirth")} />
          <Select label="Genre" value={form.gender} onChange={f("gender")}>
            <option value="">Non précisé</option>
            <option value="M">Homme</option>
            <option value="F">Femme</option>
            <option value="Autre">Autre</option>
          </Select>
        </div>

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
          <Button onClick={save} loading={saving} className="flex-1">
            {editing ? "Enregistrer" : "Ajouter"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
