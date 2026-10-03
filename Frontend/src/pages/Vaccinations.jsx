import { useEffect, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input, Textarea, Select } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { MemberAvatar } from "../components/members/MemberAvatar";
import { Plus, Trash2, Loader2, Syringe, Calendar, User, Hash, Pencil } from "lucide-react";
import { formatDate, isFuture } from "../lib/utils";
import toast from "react-hot-toast";

const COMMON_VACCINES = [
  "BCG",
  "DTP (Diphtérie-Tétanos-Polio)",
  "ROR (Rougeole-Oreillons-Rubéole)",
  "Hépatite B",
  "Méningocoque",
  "Pneumocoque",
  "Varicelle",
  "Grippe (Influenza)",
  "COVID-19",
  "HPV",
  "Rotavirus",
  "Autre",
];

const defaultForm = {
  memberId: "",
  vaccineName: "",
  dateAdministered: "",
  nextDoseDate: "",
  administeredBy: "",
  lotNumber: "",
  notes: "",
};

export default function VaccinationsPage() {
  // Fiches de la famille issues du contexte, avec le niveau d'accès de
  // l'utilisateur : saisie / modification / suppression uniquement sur les
  // fiches en accès complet.
  const { selectedFamily, members, writableMembers, canWriteMember, canReadMember } = useFamily();
  const [vaccinations, setVaccinations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  const [filterMember, setFilterMember] = useState("all");
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
      const res = await fetch(`/api/vaccinations?familyId=${selectedFamily.id}`);
      setVaccinations(await res.json());
    } finally {
      setLoading(false);
    }
  };

  const openAdd = () => {
    setEditing(null);
    setForm({ ...defaultForm, memberId: writableMembers[0]?.id?.toString() ?? "" });
    setShowForm(true);
  };

  const openEdit = (v) => {
    setEditing(v);
    setForm({
      memberId: v.memberId.toString(),
      vaccineName: v.vaccineName,
      dateAdministered: v.dateAdministered ?? "",
      nextDoseDate: v.nextDoseDate ?? "",
      administeredBy: v.administeredBy ?? "",
      lotNumber: v.lotNumber ?? "",
      notes: v.notes ?? "",
    });
    setViewing(null);
    setShowForm(true);
  };

  const save = async () => {
    if (!form.memberId || !form.vaccineName.trim() || !form.dateAdministered) {
      toast.error("Champs requis manquants");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const res = await fetch("/api/vaccinations", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editing.id, ...form }),
        });
        if (res.ok) {
          toast.success("Vaccination modifiée !");
          setShowForm(false);
          load();
        } else {
          const err = await res.json().catch(() => ({}));
          toast.error(err.error || "Erreur lors de la modification");
        }
      } else {
        const res = await fetch("/api/vaccinations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        if (res.ok) {
          toast.success("Vaccination enregistrée !");
          setShowForm(false);
          load();
        } else {
          const err = await res.json().catch(() => ({}));
          toast.error(err.error || "Erreur lors de l'enregistrement");
        }
      }
    } finally {
      setSaving(false);
    }
  };

  // Suppression (depuis la carte ou le détail) — refusée par le serveur si
  // l'utilisateur n'a pas l'accès complet au dossier.
  const removeVacc = async (id) => {
    if (!confirm("Supprimer cette vaccination ?")) return false;
    const res = await fetch(`/api/vaccinations?id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Erreur lors de la suppression");
      return false;
    }
    toast.success("Supprimé");
    load();
    return true;
  };

  const deleteVacc = async (id) => {
    if (await removeVacc(id)) setViewing(null);
  };

  const deleteVaccFromCard = (id) => removeVacc(id);

  const f = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.value }));

  const getMember = (id) => members.find((m) => m.id === id);

  const filtered = filterMember === "all" ? vaccinations : vaccinations.filter((v) => v.memberId.toString() === filterMember);

  // Regroupement par membre
  const grouped = filtered.reduce((acc, v) => {
    const key = v.memberId.toString();
    if (!acc[key]) acc[key] = [];
    acc[key].push(v);
    return acc;
  }, {});

  if (!selectedFamily) {
    return (
      <AppShell>
        <div className="text-center py-20 text-gray-400">
          <Syringe size={48} className="mx-auto mb-3 opacity-30" />
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
            <h2 className="text-xl font-bold text-gray-800">Vaccinations — {selectedFamily.name}</h2>
            <p className="text-sm text-gray-500">{vaccinations.length} vaccination(s) enregistrée(s)</p>
          </div>
          {writableMembers.length > 0 && (
            <Button onClick={openAdd}>
              <Plus size={16} />
              Ajouter une vaccination
            </Button>
          )}
        </div>

        {/* Member filter */}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setFilterMember("all")}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all ${
              filterMember === "all" ? "bg-teal-600 text-white shadow-sm" : "bg-white text-gray-600 border border-gray-200 hover:border-teal-300"
            }`}
          >
            Tous
          </button>
          {members.filter((m) => canReadMember(m.id)).map((m) => (
            <button
              key={m.id}
              onClick={() => setFilterMember(m.id.toString())}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all ${
                filterMember === m.id.toString() ? "bg-teal-600 text-white shadow-sm" : "bg-white text-gray-600 border border-gray-200 hover:border-teal-300"
              }`}
            >
              {m.firstName}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="animate-spin text-teal-600" size={36} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-16 text-center">
            <div className="w-20 h-20 bg-amber-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Syringe size={36} className="text-amber-400" />
            </div>
            <h3 className="text-lg font-bold text-gray-700 mb-2">Aucune vaccination</h3>
            <p className="text-gray-400 mb-6">Tenez à jour le carnet de vaccinations de votre famille.</p>
            {members.length === 0 ? (
              <p className="text-sm text-amber-600 bg-amber-50 px-4 py-2 rounded-xl inline-block">
                ⚠️ Ajoutez d'abord un membre depuis la page Membres
              </p>
            ) : writableMembers.length > 0 ? (
              <Button onClick={openAdd}>
                <Plus size={16} />
                Enregistrer une vaccination
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(grouped).map(([memberId, vacs]) => {
              const member = getMember(parseInt(memberId));
              if (!member) return null;
              return (
                <div key={memberId} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="px-6 py-4 bg-gradient-to-r from-amber-50 to-orange-50 border-b border-amber-100">
                    <MemberAvatar member={member} size="md" showName showAge />
                  </div>
                  <div className="divide-y divide-gray-50">
                    {vacs.map((v) => (
                      <div
                        key={v.id}
                        onClick={() => setViewing(v)}
                        className="px-6 py-4 flex items-center gap-4 hover:bg-gray-50 transition-colors cursor-pointer"
                        title="Cliquez pour voir les détails"
                      >
                        <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center flex-shrink-0">
                          <Syringe size={18} className="text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold text-gray-800">{v.vaccineName}</h3>
                            {v.nextDoseDate && isFuture(v.nextDoseDate) && <Badge variant="warning">Rappel prévu</Badge>}
                          </div>
                          <div className="flex flex-wrap gap-3 mt-1 text-xs text-gray-500">
                            <span className="flex items-center gap-1">
                              <Calendar size={11} />
                              Administré le {formatDate(v.dateAdministered)}
                            </span>
                            {v.nextDoseDate && <span className="flex items-center gap-1">🔄 Rappel: {formatDate(v.nextDoseDate)}</span>}
                            {v.administeredBy && (
                              <span className="flex items-center gap-1">
                                <User size={11} />
                                {v.administeredBy}
                              </span>
                            )}
                            {v.lotNumber && (
                              <span className="flex items-center gap-1">
                                <Hash size={11} />
                                Lot: {v.lotNumber}
                              </span>
                            )}
                          </div>
                          {v.notes && <p className="text-xs text-gray-400 mt-1 italic">{v.notes}</p>}
                        </div>
                        {canWriteMember(v.memberId) && (
                          <button onClick={(e) => { e.stopPropagation(); deleteVaccFromCard(v.id); }} className="p-2 rounded-xl hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors">
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal de détails de la vaccination */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title="Détails de la vaccination" size="lg">
        {viewing && (
          <div className="space-y-6">
            {/* En-tête */}
            <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-2xl p-5 border border-amber-100">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center flex-shrink-0">
                  <Syringe size={26} className="text-amber-600" />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold text-gray-800">{viewing.vaccineName}</h3>
                  {viewing.nextDoseDate && isFuture(viewing.nextDoseDate) && (
                    <div className="mt-1">
                      <Badge variant="warning">Rappel prévu</Badge>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Membre concerné */}
            {viewedMember && (
              <div>
                <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-2">Membre vacciné</h4>
                <div className="bg-gray-50 rounded-xl p-3">
                  <MemberAvatar member={viewedMember} size="md" showName showAge />
                </div>
              </div>
            )}

            {/* Informations de la vaccination */}
            <div>
              <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Informations</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400 font-medium flex items-center gap-1">
                    <Calendar size={11} /> Date d'administration
                  </p>
                  <p className="text-sm font-semibold text-gray-700">{formatDate(viewing.dateAdministered)}</p>
                </div>
                {viewing.nextDoseDate && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium">Prochain rappel</p>
                    <p className="text-sm font-semibold text-gray-700">{formatDate(viewing.nextDoseDate)}</p>
                  </div>
                )}
                {viewing.administeredBy && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium flex items-center gap-1">
                      <User size={11} /> Administré par
                    </p>
                    <p className="text-sm font-semibold text-gray-700">{viewing.administeredBy}</p>
                  </div>
                )}
                {viewing.lotNumber && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium flex items-center gap-1">
                      <Hash size={11} /> N° de lot
                    </p>
                    <p className="text-sm font-semibold text-gray-700">{viewing.lotNumber}</p>
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
                <Button
                  variant="ghost"
                  onClick={() => deleteVacc(viewing.id)}
                  className="flex-1 text-red-500 hover:bg-red-50"
                >
                  <Trash2 size={15} />
                  Supprimer
                </Button>
              )}
              {canWriteMember(viewing.memberId) && (
                <Button
                  variant="ghost"
                  onClick={() => openEdit(viewing)}
                  className="flex-1"
                >
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

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? "Modifier la vaccination" : "Enregistrer une vaccination"} size="lg">
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
          <Select label="Vaccin *" value={form.vaccineName} onChange={f("vaccineName")}>
            <option value="">Sélectionnez un vaccin</option>
            {COMMON_VACCINES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
          {form.vaccineName === "Autre" && (
            <Input label="Nom du vaccin *" placeholder="Précisez le vaccin..." value={form.vaccineName === "Autre" ? "" : form.vaccineName} onChange={f("vaccineName")} />
          )}
          <div className="grid grid-cols-2 gap-4">
            <Input label="Date d'administration *" type="date" value={form.dateAdministered} onChange={f("dateAdministered")} />
            <Input label="Date du prochain rappel" type="date" value={form.nextDoseDate} onChange={f("nextDoseDate")} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Administré par" placeholder="Dr. Dupont" value={form.administeredBy} onChange={f("administeredBy")} />
            <Input label="N° de lot" placeholder="Numéro de lot" value={form.lotNumber} onChange={f("lotNumber")} />
          </div>
          <Textarea label="Notes" placeholder="Réactions éventuelles, remarques..." value={form.notes} onChange={f("notes")} />
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
