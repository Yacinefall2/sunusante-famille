import { useEffect, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input, Textarea, Select } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { MemberAvatar } from "../components/members/MemberAvatar";
import { Plus, Pencil, Trash2, Loader2, Pill, User, Calendar, Stethoscope, X } from "lucide-react";
import { formatDate } from "../lib/utils";
import toast from "react-hot-toast";

const emptyMedication = { name: "", dosage: "", frequency: "", duration: "" };

const defaultForm = {
  memberId: "",
  disease: "",
  startDate: "",
  endDate: "",
  prescribedBy: "",
  isActive: true,
  notes: "",
  medications: [{ ...emptyMedication }],
};

export default function TraitementsPage() {
  // Fiches de la famille issues du contexte, avec le niveau d'accès de
  // l'utilisateur : saisie / modification / suppression uniquement sur les
  // fiches en accès complet.
  const { selectedFamily, members, writableMembers, canWriteMember } = useFamily();
  const [treatments, setTreatments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  const [filterActive, setFilterActive] = useState("all");
  const [viewing, setViewing] = useState(null);

  useEffect(() => {
    if (selectedFamily) {
      load();
    }
  }, [selectedFamily]);

  const load = async () => {
    if (!selectedFamily) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/treatments?familyId=${selectedFamily.id}`);
      setTreatments(await res.json());
    } finally {
      setLoading(false);
    }
  };

  const openAdd = () => {
    setEditing(null);
    setForm({ ...defaultForm, memberId: writableMembers[0]?.id?.toString() ?? "", medications: [{ ...emptyMedication }] });
    setShowForm(true);
  };

  const openEdit = (t) => {
    setEditing(t);
    setForm({
      memberId: t.memberId.toString(),
      disease: t.disease,
      startDate: t.startDate ?? "",
      endDate: t.endDate ?? "",
      prescribedBy: t.prescribedBy ?? "",
      isActive: t.isActive,
      notes: t.notes ?? "",
      medications:
        t.medications && t.medications.length > 0
          ? t.medications.map((m) => ({
              name: m.name,
              dosage: m.dosage ?? "",
              frequency: m.frequency ?? "",
              duration: m.duration ?? "",
            }))
          : [{ ...emptyMedication }],
    });
    setViewing(null);
    setShowForm(true);
  };

  const addMedicationRow = () => {
    setForm((p) => ({ ...p, medications: [...p.medications, { ...emptyMedication }] }));
  };

  const removeMedicationRow = (index) => {
    setForm((p) => ({ ...p, medications: p.medications.filter((_, i) => i !== index) }));
  };

  const updateMedication = (index, key, value) => {
    setForm((p) => ({
      ...p,
      medications: p.medications.map((m, i) => (i === index ? { ...m, [key]: value } : m)),
    }));
  };

  const save = async () => {
    const validMedications = form.medications.filter((m) => m.name.trim());
    if (!form.memberId || !form.disease.trim()) {
      toast.error("Champs requis manquants");
      return;
    }
    if (validMedications.length === 0) {
      toast.error("Ajoutez au moins un médicament");
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form, medications: validMedications };
      if (editing) {
        const res = await fetch("/api/treatments", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editing.id, ...payload }),
        });
        if (res.ok) {
          toast.success("Traitement modifié !");
          setShowForm(false);
          load();
        } else {
          const err = await res.json().catch(() => ({}));
          toast.error(err.error || "Erreur lors de la modification");
        }
      } else {
        const res = await fetch("/api/treatments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          toast.success("Traitement ajouté !");
          setShowForm(false);
          load();
        } else {
          const err = await res.json().catch(() => ({}));
          toast.error(err.error || "Erreur lors de l'ajout");
        }
      }
    } finally {
      setSaving(false);
    }
  };

  // Suppression (depuis la carte ou le détail) — refusée par le serveur si
  // l'utilisateur n'a pas l'accès complet au dossier.
  const removeTreatment = async (id) => {
    if (!confirm("Supprimer ce traitement ?")) return false;
    const res = await fetch(`/api/treatments?id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Erreur lors de la suppression");
      return false;
    }
    toast.success("Supprimé");
    load();
    return true;
  };

  const deleteTreatment = async (id) => {
    if (await removeTreatment(id)) setViewing(null);
  };

  const deleteTreatmentFromCard = (id) => removeTreatment(id);

  const f = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.value }));

  const getMember = (id) => members.find((m) => m.id === id);

  const filtered = treatments.filter((t) => {
    if (filterActive === "active") return t.isActive;
    if (filterActive === "inactive") return !t.isActive;
    return true;
  });

  if (!selectedFamily) {
    return (
      <AppShell>
        <div className="text-center py-20 text-gray-400">
          <Pill size={48} className="mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">Aucune famille sélectionnée</p>
        </div>
      </AppShell>
    );
  }

  const viewedMember = viewing ? getMember(viewing.memberId) : null;

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-800">Traitements — {selectedFamily.name}</h2>
            <p className="text-sm text-gray-500">
              {treatments.filter((t) => t.isActive).length} actif(s) · {treatments.filter((t) => !t.isActive).length} terminé(s)
            </p>
          </div>
          {writableMembers.length > 0 && (
            <Button onClick={openAdd}>
              <Plus size={16} />
              Nouveau traitement
            </Button>
          )}
        </div>

        <div className="flex gap-2 flex-wrap">
          {[
            { value: "all", label: "Tous" },
            { value: "active", label: "En cours" },
            { value: "inactive", label: "Terminés" },
          ].map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilterActive(opt.value)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all ${
                filterActive === opt.value ? "bg-teal-600 text-white shadow-sm" : "bg-white text-gray-600 border border-gray-200 hover:border-teal-300"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="animate-spin text-teal-600" size={36} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-16 text-center">
            <div className="w-20 h-20 bg-violet-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Pill size={36} className="text-violet-400" />
            </div>
            <h3 className="text-lg font-bold text-gray-700 mb-2">Aucun traitement</h3>
            <p className="text-gray-400 mb-6">Enregistrez les traitements et médicaments de votre famille.</p>
            {members.length === 0 ? (
              <p className="text-sm text-amber-600 bg-amber-50 px-4 py-2 rounded-xl inline-block">
                ⚠️ Ajoutez d'abord un membre depuis la page Membres
              </p>
            ) : writableMembers.length > 0 ? (
              <Button onClick={openAdd}>
                <Plus size={16} />
                Ajouter un traitement
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filtered.map((t) => {
              const member = getMember(t.memberId);
              const meds = t.medications ?? [];
              return (
                <div
                  key={t.id}
                  onClick={() => setViewing(t)}
                  className={`bg-white rounded-2xl shadow-sm border p-5 hover:shadow-md transition-all duration-200 cursor-pointer ${t.isActive ? "border-gray-100" : "border-gray-100 opacity-70"}`}
                  title="Cliquez pour voir les détails"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${t.isActive ? "bg-violet-100" : "bg-gray-100"}`}>
                        <Stethoscope size={20} className={t.isActive ? "text-violet-600" : "text-gray-400"} />
                      </div>
                      <div>
                        <h3 className="font-bold text-gray-800">{t.disease}</h3>
                        <p className="text-sm text-gray-500">
                          {meds.length === 0
                            ? "Aucun médicament"
                            : meds.length === 1
                            ? meds[0].name
                            : `${meds.length} médicaments`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <Badge variant={t.isActive ? "success" : "default"}>{t.isActive ? "Actif" : "Terminé"}</Badge>
                      {canWriteMember(t.memberId) && (
                        <button onClick={() => openEdit(t)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-teal-600 transition-colors">
                          <Pencil size={14} />
                        </button>
                      )}
                      {canWriteMember(t.memberId) && (
                        <button onClick={() => deleteTreatmentFromCard(t.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>

                  {meds.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {meds.slice(0, 3).map((m, i) => (
                        <span key={i} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 font-medium">
                          <Pill size={10} />
                          {m.name}
                        </span>
                      ))}
                      {meds.length > 3 && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-50 text-gray-500 font-medium">+{meds.length - 3}</span>
                      )}
                    </div>
                  )}

                  <div className="space-y-1.5 text-sm text-gray-500">
                    {(t.startDate || t.endDate) && (
                      <p className="flex items-center gap-2">
                        <Calendar size={13} className="text-teal-500" />
                        {t.startDate ? formatDate(t.startDate) : "—"} → {t.endDate ? formatDate(t.endDate) : "En cours"}
                      </p>
                    )}
                    {t.prescribedBy && (
                      <p className="flex items-center gap-2">
                        <User size={13} className="text-teal-500" />
                        Prescrit par {t.prescribedBy}
                      </p>
                    )}
                    {t.notes && <p className="text-xs bg-gray-50 rounded-lg px-2 py-1 italic mt-2">{t.notes}</p>}
                  </div>

                  {member && (
                    <div className="mt-3 pt-3 border-t border-gray-50">
                      <MemberAvatar member={member} size="sm" showName />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal de détails du traitement */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title="Détails du traitement" size="lg">
        {viewing && (
          <div className="space-y-6">
            {/* En-tête : maladie */}
            <div className="bg-gradient-to-r from-violet-50 to-purple-50 rounded-2xl p-5 border border-violet-100">
              <div className="flex items-center gap-4">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 ${viewing.isActive ? "bg-violet-100" : "bg-gray-100"}`}>
                  <Stethoscope size={26} className={viewing.isActive ? "text-violet-600" : "text-gray-400"} />
                </div>
                <div className="flex-1">
                  <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">Maladie / motif</p>
                  <h3 className="text-lg font-bold text-gray-800">{viewing.disease}</h3>
                  <div className="mt-1">
                    <Badge variant={viewing.isActive ? "success" : "default"}>{viewing.isActive ? "En cours" : "Terminé"}</Badge>
                  </div>
                </div>
              </div>
            </div>

            {/* Membre concerné */}
            {viewedMember && (
              <div>
                <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-2">Membre concerné</h4>
                <div className="bg-gray-50 rounded-xl p-3">
                  <MemberAvatar member={viewedMember} size="md" showName showAge />
                </div>
              </div>
            )}

            {/* Médicaments : maladie + posologie + fréquence + durée, alignés */}
            <div>
              <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">
                Médicaments ({(viewing.medications ?? []).length})
              </h4>
              {(viewing.medications ?? []).length === 0 ? (
                <p className="text-sm text-gray-400 italic">Aucun médicament renseigné.</p>
              ) : (
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="grid grid-cols-4 gap-2 bg-gray-50 px-3 py-2 text-xs font-bold text-gray-500 uppercase tracking-wide">
                    <span>Médicament</span>
                    <span>Posologie</span>
                    <span>Fréquence</span>
                    <span>Durée</span>
                  </div>
                  {viewing.medications.map((m, i) => (
                    <div key={m.id ?? i} className={`grid grid-cols-4 gap-2 px-3 py-2.5 text-sm ${i % 2 === 1 ? "bg-gray-50/60" : "bg-white"}`}>
                      <span className="font-semibold text-gray-800 flex items-center gap-1.5">
                        <Pill size={12} className="text-violet-500 flex-shrink-0" />
                        {m.name}
                      </span>
                      <span className="text-gray-600">{m.dosage || "—"}</span>
                      <span className="text-gray-600">{m.frequency || "—"}</span>
                      <span className="text-gray-600">{m.duration || "—"}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Informations générales du traitement */}
            <div>
              <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Informations générales</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {viewing.startDate && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium">Date de début</p>
                    <p className="text-sm font-semibold text-gray-700">{formatDate(viewing.startDate)}</p>
                  </div>
                )}
                {viewing.endDate ? (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium">Date de fin</p>
                    <p className="text-sm font-semibold text-gray-700">{formatDate(viewing.endDate)}</p>
                  </div>
                ) : viewing.isActive && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium">Date de fin</p>
                    <p className="text-sm font-semibold text-emerald-600">En cours</p>
                  </div>
                )}
                {viewing.prescribedBy && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium flex items-center gap-1">
                      <User size={11} /> Prescrit par
                    </p>
                    <p className="text-sm font-semibold text-gray-700">{viewing.prescribedBy}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Notes */}
            {viewing.notes && (
              <div>
                <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-2">Notes</h4>
                <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm text-gray-700 whitespace-pre-wrap">
                  {viewing.notes}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2 border-t border-gray-100">
              {canWriteMember(viewing.memberId) && (
                <Button variant="ghost" onClick={() => deleteTreatment(viewing.id)} className="flex-1 text-red-500 hover:bg-red-50">
                  <Trash2 size={15} />
                  Supprimer
                </Button>
              )}
              {canWriteMember(viewing.memberId) && (
                <Button variant="ghost" onClick={() => openEdit(viewing)} className="flex-1">
                  <Pencil size={15} />
                  Modifier
                </Button>
              )}
              <Button onClick={() => setViewing(null)} className="flex-1">
                Fermer
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal d'ajout / modification */}
      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? "Modifier le traitement" : "Nouveau traitement"} size="lg">
        <div className="space-y-4">
          {/* Uniquement les fiches sur lesquelles l'utilisateur peut écrire */}
          <Select label="Membre *" value={form.memberId} onChange={f("memberId")}>
            <option value="">Sélectionnez un membre</option>
            {writableMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.firstName} {m.lastName}
              </option>
            ))}
          </Select>

          <Input label="Maladie / motif du traitement *" placeholder="Paludisme, hypertension, grippe..." value={form.disease} onChange={f("disease")} />

          {/* Liste des médicaments — un traitement peut en concerner plusieurs */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-semibold text-gray-700">Médicaments *</label>
              <button
                type="button"
                onClick={addMedicationRow}
                className="inline-flex items-center gap-1 text-xs font-semibold text-teal-600 hover:text-teal-700"
              >
                <Plus size={14} />
                Ajouter un médicament
              </button>
            </div>

            <div className="space-y-3">
              {form.medications.map((m, i) => (
                <div key={i} className="border border-gray-200 rounded-xl p-3 bg-gray-50/60 relative">
                  {form.medications.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeMedicationRow(i)}
                      className="absolute top-2 right-2 p-1 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                      title="Retirer ce médicament"
                    >
                      <X size={14} />
                    </button>
                  )}
                  <Input
                    label={`Médicament ${i + 1}`}
                    placeholder="Amoxicilline, Paracétamol..."
                    value={m.name}
                    onChange={(e) => updateMedication(i, "name", e.target.value)}
                  />
                  <div className="grid grid-cols-3 gap-3 mt-3">
                    <Input label="Posologie" placeholder="500mg" value={m.dosage} onChange={(e) => updateMedication(i, "dosage", e.target.value)} />
                    <Input label="Fréquence" placeholder="2x/jour" value={m.frequency} onChange={(e) => updateMedication(i, "frequency", e.target.value)} />
                    <Input label="Durée" placeholder="7 jours" value={m.duration} onChange={(e) => updateMedication(i, "duration", e.target.value)} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input label="Date de début" type="date" value={form.startDate} onChange={f("startDate")} />
            <Input label="Date de fin" type="date" value={form.endDate} onChange={f("endDate")} />
          </div>
          <Input label="Prescrit par" placeholder="Dr. Martin" value={form.prescribedBy} onChange={f("prescribedBy")} />
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="isActive"
              checked={form.isActive}
              onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.checked }))}
              className="w-4 h-4 rounded text-teal-600"
            />
            <label htmlFor="isActive" className="text-sm font-semibold text-gray-700">
              Traitement en cours
            </label>
          </div>
          <Textarea label="Notes" placeholder="Instructions, effets secondaires..." value={form.notes} onChange={f("notes")} />
          <div className="flex gap-3 pt-2">
            <Button variant="ghost" onClick={() => setShowForm(false)} className="flex-1">
              Annuler
            </Button>
            <Button onClick={save} loading={saving} className="flex-1">
              {editing ? "Enregistrer" : "Ajouter"}
            </Button>
          </div>
        </div>
      </Modal>
    </AppShell>
  );
}