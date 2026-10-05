import { useEffect, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input, Textarea, Select } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { MemberAvatar } from "../components/members/MemberAvatar";
import { Plus, Trash2, Loader2, Syringe, Calendar, User, Hash, Pencil, CheckCircle2, AlertTriangle } from "lucide-react";
import { formatDate } from "../lib/utils";
import { notifyNotificationsChanged } from "../components/notifications/intakes";
import { format } from "date-fns";
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

// Date du jour au format des champs date (yyyy-MM-dd), en heure locale.
const todayISO = () => format(new Date(), "yyyy-MM-dd");

// Badge du statut de rappel renvoyé par le serveur (boosterStatus).
// `boosterDose` : vaccination qui a enregistré le rappel, si présente dans la liste.
function BoosterBadge({ vaccination, boosterDose }) {
  switch (vaccination.boosterStatus) {
    case "a_faire":
      return <Badge variant="warning">Rappel à faire le {formatDate(vaccination.nextDoseDate)}</Badge>;
    case "en_retard":
      return (
        <Badge variant="danger">
          <AlertTriangle size={11} />
          Rappel en retard depuis le {formatDate(vaccination.nextDoseDate)}
        </Badge>
      );
    case "fait":
      return (
        <Badge variant="success">
          <CheckCircle2 size={11} />
          Rappel effectué{boosterDose ? ` le ${formatDate(boosterDose.dateAdministered)}` : ""}
        </Badge>
      );
    default:
      return null;
  }
}

// Rappel encore à enregistrer (à faire ou en retard).
const needsBooster = (v) => v.boosterStatus === "a_faire" || v.boosterStatus === "en_retard";

const defaultBoosterForm = {
  dateAdministered: "",
  administeredBy: "",
  lotNumber: "",
  nextDoseDate: "",
  notes: "",
};

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
  // Filtre « En retard » : uniquement les rappels dépassés.
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  // Enregistrement d'un rappel effectué : vaccination d'origine + formulaire.
  const [boosterFor, setBoosterFor] = useState(null);
  const [boosterForm, setBoosterForm] = useState(defaultBoosterForm);
  const [boosterSaving, setBoosterSaving] = useState(false);

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
      const data = res.ok ? await res.json() : [];
      setVaccinations(Array.isArray(data) ? data : []);
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

  // Ouvre la fenêtre « Enregistrer le rappel » pour une vaccination dont le
  // rappel est à faire ou en retard.
  const openBooster = (v) => {
    setBoosterFor(v);
    setBoosterForm({
      ...defaultBoosterForm,
      dateAdministered: todayISO(),
      administeredBy: v.administeredBy ?? "",
    });
  };

  const saveBooster = async () => {
    if (!boosterFor) return;
    if (!boosterForm.dateAdministered) {
      toast.error("Indiquez la date de la dose");
      return;
    }
    if (boosterForm.dateAdministered > todayISO()) {
      toast.error("La date de la dose ne peut pas être dans le futur");
      return;
    }
    setBoosterSaving(true);
    try {
      // Champs vides non envoyés : le serveur applique ses valeurs par défaut.
      const body = Object.fromEntries(
        Object.entries(boosterForm)
          .map(([k, val]) => [k, typeof val === "string" ? val.trim() : val])
          .filter(([, val]) => val !== "")
      );
      const res = await fetch(`/api/vaccinations/${boosterFor.id}/booster-done`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success("Rappel enregistré");
        setBoosterFor(null);
        setViewing(null);
        notifyNotificationsChanged();
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        const fallback =
          res.status === 409
            ? "Ce rappel est déjà enregistré"
            : res.status === 403
            ? "Vous n'avez pas l'accès complet à cette fiche"
            : "Erreur lors de l'enregistrement du rappel";
        toast.error(err.error || fallback);
        if (res.status === 409) load();
      }
    } catch {
      toast.error("Erreur lors de l'enregistrement du rappel");
    } finally {
      setBoosterSaving(false);
    }
  };

  const f = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.value }));
  const bf = (key) => (e) => setBoosterForm((p) => ({ ...p, [key]: e.target.value }));

  const getMember = (id) => members.find((m) => m.id === id);
  const getVaccination = (id) => (id ? vaccinations.find((x) => x.id === id) : null);

  // Rappels en retard (tous membres), du plus ancien au plus récent.
  const overdue = vaccinations
    .filter((v) => v.boosterStatus === "en_retard")
    .sort((a, b) => (a.nextDoseDate < b.nextDoseDate ? -1 : 1));

  const filtered = vaccinations
    .filter((v) => filterMember === "all" || v.memberId.toString() === filterMember)
    .filter((v) => !onlyOverdue || v.boosterStatus === "en_retard");

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

        {/* Bandeau des rappels en retard */}
        {overdue.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-5">
            <h3 className="font-bold text-red-700 flex items-center gap-2 mb-3">
              <AlertTriangle size={18} />
              {overdue.length} rappel{overdue.length > 1 ? "s" : ""} de vaccin en retard
            </h3>
            <div className="space-y-2">
              {overdue.map((v) => {
                const member = getMember(v.memberId);
                return (
                  <div key={v.id} className="flex items-center justify-between gap-3 flex-wrap bg-white rounded-xl px-3 py-2 border border-red-100">
                    <button type="button" onClick={() => setViewing(v)} className="text-sm text-left text-gray-700 min-w-0 hover:underline">
                      <span className="font-semibold">{member ? `${member.firstName} ${member.lastName}` : "Membre"}</span>
                      {" · "}
                      {v.vaccineName}
                      <span className="text-red-600"> — prévu le {formatDate(v.nextDoseDate)}</span>
                    </button>
                    {canWriteMember(v.memberId) && (
                      <Button size="sm" onClick={() => openBooster(v)}>
                        <CheckCircle2 size={14} />
                        Rappel effectué
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

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
          {/* Filtre complémentaire : rappels en retard uniquement */}
          <button
            onClick={() => setOnlyOverdue((o) => !o)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all inline-flex items-center gap-1.5 ${
              onlyOverdue ? "bg-red-600 text-white shadow-sm" : "bg-white text-red-600 border border-red-200 hover:border-red-300"
            }`}
          >
            <AlertTriangle size={13} />
            En retard{overdue.length > 0 ? ` (${overdue.length})` : ""}
          </button>
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
            <h3 className="text-lg font-bold text-gray-700 mb-2">{onlyOverdue ? "Aucun rappel en retard" : "Aucune vaccination"}</h3>
            <p className="text-gray-400 mb-6">
              {onlyOverdue ? "Tous les rappels prévus sont à jour." : "Tenez à jour le carnet de vaccinations de votre famille."}
            </p>
            {onlyOverdue ? null : members.length === 0 ? (
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
                            <BoosterBadge vaccination={v} boosterDose={getVaccination(v.boosterDoneVaccinationId)} />
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
                        {canWriteMember(v.memberId) && needsBooster(v) && (
                          <Button
                            size="sm"
                            variant={v.boosterStatus === "en_retard" ? "danger" : "outline"}
                            onClick={(e) => { e.stopPropagation(); openBooster(v); }}
                            className="flex-shrink-0"
                            title="Rappel effectué"
                          >
                            <CheckCircle2 size={14} />
                            <span className="hidden sm:inline">Rappel effectué</span>
                          </Button>
                        )}
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
                  {viewing.boosterStatus && (
                    <div className="mt-1">
                      <BoosterBadge vaccination={viewing} boosterDose={getVaccination(viewing.boosterDoneVaccinationId)} />
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
                    <p className={`text-sm font-semibold ${viewing.boosterStatus === "en_retard" ? "text-red-600" : "text-gray-700"}`}>
                      {formatDate(viewing.nextDoseDate)}
                    </p>
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
            {canWriteMember(viewing.memberId) && needsBooster(viewing) && (
              <Button
                variant={viewing.boosterStatus === "en_retard" ? "danger" : "outline"}
                onClick={() => openBooster(viewing)}
                className="w-full"
              >
                <CheckCircle2 size={15} />
                Rappel effectué
              </Button>
            )}
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

      {/* Modal « Enregistrer le rappel » : crée la dose de rappel côté serveur */}
      <Modal open={!!boosterFor} onClose={() => setBoosterFor(null)} title="Enregistrer le rappel">
        {boosterFor && (
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 text-sm text-gray-700">
              <p className="font-semibold">{boosterFor.vaccineName}</p>
              <p className="text-xs text-gray-500">
                {getMember(boosterFor.memberId) &&
                  `${getMember(boosterFor.memberId).firstName} ${getMember(boosterFor.memberId).lastName} · `}
                Rappel prévu le {formatDate(boosterFor.nextDoseDate)}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Input label="Date de la dose *" type="date" max={todayISO()} value={boosterForm.dateAdministered} onChange={bf("dateAdministered")} />
              <Input label="Prochain rappel" type="date" value={boosterForm.nextDoseDate} onChange={bf("nextDoseDate")} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Input label="Administré par" placeholder="Dr. Dupont" value={boosterForm.administeredBy} onChange={bf("administeredBy")} />
              <Input label="Numéro de lot" placeholder="Numéro de lot" value={boosterForm.lotNumber} onChange={bf("lotNumber")} />
            </div>
            <Textarea label="Notes" placeholder="Réactions éventuelles, remarques..." value={boosterForm.notes} onChange={bf("notes")} />
            <div className="flex gap-3 pt-2">
              <Button variant="ghost" onClick={() => setBoosterFor(null)} className="flex-1">
                Annuler
              </Button>
              <Button onClick={saveBooster} loading={boosterSaving} className="flex-1">
                Enregistrer
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
