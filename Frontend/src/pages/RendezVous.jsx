import { useEffect, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input, Textarea, Select } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { MemberAvatar } from "../components/members/MemberAvatar";
import { Plus, Pencil, Trash2, Loader2, Calendar, Clock, MapPin, Stethoscope, User, BellRing } from "lucide-react";
import { formatDateTime, APPOINTMENT_STATUSES } from "../lib/utils";
import toast from "react-hot-toast";

const defaultForm = {
  memberId: "",
  title: "",
  doctorName: "",
  location: "",
  appointmentDate: "",
  notes: "",
  status: "upcoming",
};

export default function RendezVousPage() {
  // Fiches de la famille (avec le niveau d'accès de l'utilisateur) issues du
  // contexte : on ne saisit / modifie / supprime que sur les fiches en accès
  // complet ; les autres sont en lecture seule ou "à relayer".
  const { selectedFamily, members, writableMembers, canWriteMember } = useFamily();
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  const [filterStatus, setFilterStatus] = useState("all");
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
      const res = await fetch(`/api/appointments?familyId=${selectedFamily.id}`);
      setAppointments(await res.json());
    } finally {
      setLoading(false);
    }
  };

  const openAdd = () => {
    setEditing(null);
    setForm({ ...defaultForm, memberId: writableMembers[0]?.id?.toString() ?? "" });
    setShowForm(true);
  };

  const openEdit = (a) => {
    setEditing(a);
    const dt = new Date(a.appointmentDate);
    const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    setForm({
      memberId: a.memberId.toString(),
      title: a.title,
      doctorName: a.doctorName ?? "",
      location: a.location ?? "",
      appointmentDate: local,
      notes: a.notes ?? "",
      status: a.status,
    });
    setViewing(null);
    setShowForm(true);
  };

  const save = async () => {
    if (!form.memberId || !form.title.trim() || !form.appointmentDate) {
      toast.error("Champs requis manquants");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const res = await fetch("/api/appointments", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editing.id, ...form }),
        });
        if (res.ok) {
          toast.success("Rendez-vous modifié !");
          setShowForm(false);
          load();
        } else {
          const err = await res.json().catch(() => ({}));
          toast.error(err.error || "Erreur lors de la modification");
        }
      } else {
        const res = await fetch("/api/appointments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        if (res.ok) {
          toast.success("Rendez-vous ajouté !");
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
  const removeAppt = async (id) => {
    if (!confirm("Supprimer ce rendez-vous ?")) return false;
    const res = await fetch(`/api/appointments?id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Erreur lors de la suppression");
      return false;
    }
    toast.success("Supprimé");
    load();
    return true;
  };

  const deleteAppt = async (id) => {
    if (await removeAppt(id)) setViewing(null);
  };

  const deleteApptFromCard = (id) => removeAppt(id);

  // Modifiable / supprimable : accès complet sur la fiche, et jamais une
  // ligne restreinte (rendez-vous à relayer).
  const canManage = (appt) => !appt.restricted && canWriteMember(appt.memberId);

  const f = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.value }));

  const getMember = (id) => members.find((m) => m.id === id);

  const filtered = filterStatus === "all" ? appointments : appointments.filter((a) => a.status === filterStatus);

  const getStatusBadge = (status) => {
    const s = APPOINTMENT_STATUSES.find((a) => a.value === status);
    if (!s) return null;
    const variant = status === "upcoming" ? "info" : status === "completed" ? "success" : "danger";
    return <Badge variant={variant}>{s.label}</Badge>;
  };

  if (!selectedFamily) {
    return (
      <AppShell>
        <div className="text-center py-20 text-gray-400">
          <Calendar size={48} className="mx-auto mb-3 opacity-30" />
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
            <h2 className="text-xl font-bold text-gray-800">Rendez-vous — {selectedFamily.name}</h2>
            <p className="text-sm text-gray-500">{appointments.length} rendez-vous au total</p>
          </div>
          {writableMembers.length > 0 && (
            <Button onClick={openAdd}>
              <Plus size={16} />
              Nouveau rendez-vous
            </Button>
          )}
        </div>

        {/* Filter */}
        <div className="flex gap-2 flex-wrap">
          {[{ value: "all", label: "Tous" }, ...APPOINTMENT_STATUSES].map((s) => (
            <button
              key={s.value}
              onClick={() => setFilterStatus(s.value)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all ${
                filterStatus === s.value ? "bg-teal-600 text-white shadow-sm" : "bg-white text-gray-600 border border-gray-200 hover:border-teal-300"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="animate-spin text-teal-600" size={36} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-16 text-center">
            <div className="w-20 h-20 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Calendar size={36} className="text-blue-400" />
            </div>
            <h3 className="text-lg font-bold text-gray-700 mb-2">Aucun rendez-vous</h3>
            <p className="text-gray-400 mb-6">Planifiez des consultations médicales pour votre famille.</p>
            {members.length === 0 ? (
              <p className="text-sm text-amber-600 bg-amber-50 px-4 py-2 rounded-xl inline-block">
                ⚠️ Ajoutez d'abord un membre depuis la page Membres
              </p>
            ) : writableMembers.length > 0 ? (
              <Button onClick={openAdd}>
                <Plus size={16} />
                Planifier un rendez-vous
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((appt) => {
              const member = getMember(appt.memberId);
              // Rendez-vous d'un dossier dont on est Relais : seuls la date,
              // l'heure et le lieu sont connus, à transmettre à la personne.
              if (appt.restricted) {
                return (
                  <div
                    key={appt.id}
                    onClick={() => setViewing(appt)}
                    className="bg-white rounded-2xl shadow-sm border border-amber-100 p-5 hover:shadow-md transition-all duration-200 cursor-pointer"
                    title="Cliquez pour voir les détails"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                      <div className="flex-shrink-0">
                        <div className="w-12 h-12 bg-amber-50 rounded-xl flex items-center justify-center">
                          <BellRing size={22} className="text-amber-600" />
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-bold text-gray-800">Rendez-vous à relayer</h3>
                          {getStatusBadge(appt.status)}
                        </div>
                        <div className="flex flex-wrap gap-4 mt-3 text-sm text-gray-500">
                          <span className="flex items-center gap-1.5">
                            <Clock size={13} className="text-amber-500" />
                            {formatDateTime(appt.appointmentDate)}
                          </span>
                          {appt.location && (
                            <span className="flex items-center gap-1.5">
                              <MapPin size={13} className="text-amber-500" />
                              {appt.location}
                            </span>
                          )}
                          {member && <MemberAvatar member={member} size="sm" showName />}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={appt.id}
                  onClick={() => setViewing(appt)}
                  className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 hover:shadow-md transition-all duration-200 cursor-pointer"
                  title="Cliquez pour voir les détails"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                    <div className="flex-shrink-0">
                      <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center">
                        <Stethoscope size={22} className="text-blue-600" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-bold text-gray-800">{appt.title}</h3>
                            {getStatusBadge(appt.status)}
                          </div>
                          {appt.doctorName && (
                            <p className="text-sm text-gray-500 flex items-center gap-1 mt-1">
                              <User size={13} /> {appt.doctorName}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                          {canManage(appt) && (
                            <button onClick={() => openEdit(appt)} className="p-2 rounded-xl hover:bg-gray-100 text-gray-400 hover:text-teal-600 transition-colors">
                              <Pencil size={15} />
                            </button>
                          )}
                          {canManage(appt) && (
                            <button onClick={() => deleteApptFromCard(appt.id)} className="p-2 rounded-xl hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-4 mt-3 text-sm text-gray-500">
                        <span className="flex items-center gap-1.5">
                          <Clock size={13} className="text-teal-500" />
                          {formatDateTime(appt.appointmentDate)}
                        </span>
                        {appt.location && (
                          <span className="flex items-center gap-1.5">
                            <MapPin size={13} className="text-teal-500" />
                            {appt.location}
                          </span>
                        )}
                        {member && <MemberAvatar member={member} size="sm" showName />}
                      </div>
                      {appt.notes && <p className="text-sm text-gray-400 mt-2 bg-gray-50 rounded-lg px-3 py-2 italic">{appt.notes}</p>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal de détails du rendez-vous */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title="Détails du rendez-vous" size="lg">
        {viewing && (
          <div className="space-y-6">
            {/* En-tête */}
            <div className="bg-gradient-to-r from-blue-50 to-cyan-50 rounded-2xl p-5 border border-blue-100">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 bg-blue-100 rounded-2xl flex items-center justify-center flex-shrink-0">
                    {viewing.restricted ? (
                      <BellRing size={26} className="text-amber-600" />
                    ) : (
                      <Stethoscope size={26} className="text-blue-600" />
                    )}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-gray-800">
                      {viewing.restricted ? "Rendez-vous à relayer" : viewing.title}
                    </h3>
                    <div className="mt-1">{getStatusBadge(viewing.status)}</div>
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

            {/* Informations du rendez-vous */}
            <div>
              <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Informations</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400 font-medium flex items-center gap-1">
                    <Clock size={11} /> Date et heure
                  </p>
                  <p className="text-sm font-semibold text-gray-700">{formatDateTime(viewing.appointmentDate)}</p>
                </div>
                {viewing.doctorName && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium flex items-center gap-1">
                      <User size={11} /> Médecin / Praticien
                    </p>
                    <p className="text-sm font-semibold text-gray-700">{viewing.doctorName}</p>
                  </div>
                )}
                {viewing.location && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium flex items-center gap-1">
                      <MapPin size={11} /> Lieu / Cabinet
                    </p>
                    <p className="text-sm font-semibold text-gray-700">{viewing.location}</p>
                  </div>
                )}
                {viewing.createdAt && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium">Créé le</p>
                    <p className="text-sm font-semibold text-gray-700">{formatDateTime(viewing.createdAt)}</p>
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

            {viewing.restricted && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-xl p-3">
                Vous êtes Relais pour ce dossier : seuls la date, l'heure et le lieu vous sont communiqués, pour que
                vous puissiez rappeler ce rendez-vous à la personne.
              </p>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2 border-t border-gray-100">
              {canManage(viewing) && (
                <Button
                  variant="ghost"
                  onClick={() => deleteAppt(viewing.id)}
                  className="flex-1 text-red-500 hover:bg-red-50"
                >
                  <Trash2 size={15} />
                  Supprimer
                </Button>
              )}
              {canManage(viewing) && (
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

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? "Modifier le rendez-vous" : "Nouveau rendez-vous"} size="lg">
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
          <Input label="Titre / Motif *" placeholder="Consultation générale, Dentiste..." value={form.title} onChange={f("title")} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Médecin / Praticien" placeholder="Dr. Dupont" value={form.doctorName} onChange={f("doctorName")} />
            <Input label="Lieu / Cabinet" placeholder="Clinique Saint-Louis" value={form.location} onChange={f("location")} />
          </div>
          <Input label="Date et heure *" type="datetime-local" value={form.appointmentDate} onChange={f("appointmentDate")} />
          <Select label="Statut" value={form.status} onChange={f("status")}>
            {APPOINTMENT_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          <Textarea label="Notes" placeholder="Informations complémentaires..." value={form.notes} onChange={f("notes")} />
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
