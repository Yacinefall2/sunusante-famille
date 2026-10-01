import { useEffect, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { useAuth } from "../context/AuthContext";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input, Textarea, Select } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { MemberAvatar } from "../components/members/MemberAvatar";
import { Plus, Pencil, Trash2, Loader2, Users, Heart, Droplets, AlertTriangle, Calendar, FileText, Pill, Syringe } from "lucide-react";
import { calculateAge, AVATAR_COLORS, BLOOD_TYPES, formatDate } from "../lib/utils";
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
};

// Axe 3 du modèle d'acteurs — statut de la personne. Change l'affichage et
// le canal de notification, jamais les droits d'accès.
const STATUS_OPTIONS = [
  { value: "connecte_autonome", label: "Connecté autonome" },
  { value: "connecte_assiste", label: "Connecté assisté (mode senior)" },
  { value: "adolescent", label: "Adolescent" },
  { value: "mineur_gere", label: "Mineur géré (aucun compte)" },
  { value: "non_connecte", label: "Non connecté (proche au village)" },
];

// Axe 2 du modèle d'acteurs — rôles attribuables sur un dossier précis.
const DOCUMENT_ROLE_OPTIONS = [
  { value: "titulaire", label: "Titulaire (propriétaire du dossier)" },
  { value: "gestionnaire", label: "Gestionnaire (saisit et administre)" },
  { value: "relais", label: "Relais (rappel à transmettre uniquement)" },
  { value: "lecteur_invite", label: "Lecteur invité (consultation seule)" },
];
const DOCUMENT_ROLE_LABELS = Object.fromEntries(DOCUMENT_ROLE_OPTIONS.map((r) => [r.value, r.label.split(" (")[0]]));

export default function MembresPage() {
  const { selectedFamily, isParent, canWrite } = useFamily();
  const { user } = useAuth();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [memberStats, setMemberStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  // Rôle (par userId) de chaque compte de la famille — permet de savoir si la
  // fiche d'un membre appartient à un AUTRE Parent (auquel cas ni modifiable
  // ni supprimable par le Parent courant, seul l'intéressé peut la modifier).
  const [roleByUserId, setRoleByUserId] = useState({});
  // Liste complète des comptes de la famille (nom, email, rôle) — pour le
  // sélecteur d'attribution de rôle Axe 2 (UC-04).
  const [familyAccounts, setFamilyAccounts] = useState([]);
  // Rôles Axe 2 (Titulaire/Gestionnaire/Relais/Lecteur invité) attribués sur
  // la fiche actuellement affichée dans le détail.
  const [memberDocRoles, setMemberDocRoles] = useState([]);
  const [docRolesLoading, setDocRolesLoading] = useState(false);
  const [newRoleUserId, setNewRoleUserId] = useState("");
  const [newRoleType, setNewRoleType] = useState("gestionnaire");
  const [assigningRole, setAssigningRole] = useState(false);
  const [revokingRoleId, setRevokingRoleId] = useState(null);

  useEffect(() => {
    if (selectedFamily) {
      loadMembers();
      loadMemberships();
    }
  }, [selectedFamily]);

  const loadMembers = async () => {
    if (!selectedFamily) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/members?familyId=${selectedFamily.id}`);
      const data = await res.json();
      setMembers(data);
    } finally {
      setLoading(false);
    }
  };

  const loadMemberships = async () => {
    if (!selectedFamily) return;
    try {
      const res = await fetch(`/api/family-memberships?familyId=${selectedFamily.id}`);
      const rows = await res.json();
      setRoleByUserId(Object.fromEntries(rows.map((r) => [r.userId, r.role])));
      setFamilyAccounts(rows);
    } catch {
      setRoleByUserId({});
      setFamilyAccounts([]);
    }
  };

  const loadDocumentRoles = async (memberId) => {
    setDocRolesLoading(true);
    try {
      const res = await fetch(`/api/document-roles?memberId=${memberId}`);
      const data = await res.json();
      setMemberDocRoles(Array.isArray(data) ? data : []);
    } catch {
      setMemberDocRoles([]);
    } finally {
      setDocRolesLoading(false);
    }
  };

  const assignDocumentRole = async () => {
    if (!newRoleUserId) {
      toast.error("Choisissez une personne");
      return;
    }
    setAssigningRole(true);
    try {
      const res = await fetch("/api/document-roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: viewing.id, userId: newRoleUserId, role: newRoleType }),
      });
      if (res.ok) {
        toast.success("Rôle attribué !");
        setNewRoleUserId("");
        loadDocumentRoles(viewing.id);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Erreur lors de l'attribution du rôle");
      }
    } finally {
      setAssigningRole(false);
    }
  };

  const revokeDocumentRole = async (id) => {
    setRevokingRoleId(id);
    try {
      await fetch(`/api/document-roles?id=${id}`, { method: "DELETE" });
      toast.success("Rôle révoqué");
      loadDocumentRoles(viewing.id);
    } finally {
      setRevokingRoleId(null);
    }
  };

  const openView = async (m) => {
    setViewing(m);
    setStatsLoading(true);
    setMemberStats(null);
    setNewRoleUserId("");
    setNewRoleType("gestionnaire");
    if (isParent) loadDocumentRoles(m.id);
    try {
      const [apptsRes, vaccsRes, treatsRes, docsRes] = await Promise.all([
        fetch(`/api/appointments?memberId=${m.id}`),
        fetch(`/api/vaccinations?memberId=${m.id}`),
        fetch(`/api/treatments?memberId=${m.id}`),
        fetch(`/api/documents?memberId=${m.id}`),
      ]);
      const [appointments, vaccinations, treatments, documents] = await Promise.all([
        apptsRes.json(),
        vaccsRes.json(),
        treatsRes.json(),
        docsRes.json(),
      ]);
      setMemberStats({ appointments, vaccinations, treatments, documents });
    } catch (err) {
      console.error(err);
    } finally {
      setStatsLoading(false);
    }
  };

  const openAdd = () => {
    setEditing(null);
    setForm({ ...defaultForm, avatarColor: AVATAR_COLORS[members.length % AVATAR_COLORS.length] });
    setShowForm(true);
  };

  const openEdit = (m) => {
    setEditing(m);
    setForm({
      firstName: m.firstName,
      lastName: m.lastName,
      dateOfBirth: m.dateOfBirth ?? "",
      gender: m.gender ?? "",
      bloodType: m.bloodType ?? "",
      allergies: m.allergies ?? "",
      notes: m.notes ?? "",
      avatarColor: m.avatarColor ?? AVATAR_COLORS[0],
      status: m.status ?? "connecte_autonome",
    });
    setShowForm(true);
  };

  const save = async () => {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      toast.error("Prénom et nom sont requis");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const res = await fetch("/api/members", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editing.id, ...form }),
        });
        if (res.ok) {
          toast.success("Membre modifié !");
          setShowForm(false);
          loadMembers();
        }
      } else {
        const res = await fetch("/api/members", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ familyId: selectedFamily.id, ...form }),
        });
        if (res.ok) {
          toast.success("Membre ajouté !");
          setShowForm(false);
          loadMembers();
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const deleteMember = async (id) => {
    if (!confirm("Supprimer ce membre et toutes ses données médicales ?")) return;
    setDeleting(id);
    try {
      await fetch(`/api/members?id=${id}`, { method: "DELETE" });
      toast.success("Membre supprimé");
      loadMembers();
    } finally {
      setDeleting(null);
    }
  };

  const f = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  // Une fiche appartient à un AUTRE Parent si son créateur (guardianUserId)
  // a le rôle "parent" dans cette famille et n'est pas l'utilisateur courant.
  // Dans ce cas, aucun Parent ne peut la modifier ni la supprimer — seul
  // l'intéressé le peut.
  const isOwnedByAnotherParent = (m) =>
    !!m.guardianUserId && m.guardianUserId !== user?.id && roleByUserId[m.guardianUserId] === "parent";

  // Seul l'Admin ou la personne qui a créé la fiche peut la modifier — sauf
  // s'il s'agit de la fiche d'un autre Parent, qui reste réservée à celui-ci.
  const canEdit = (m) => m.guardianUserId === user?.id || (isParent && !isOwnedByAnotherParent(m));
  const canDelete = (m) => isParent && !isOwnedByAnotherParent(m);

  if (!selectedFamily) {
    return (
      <AppShell>
        <div className="text-center py-20 text-gray-400">
          <Users size={48} className="mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">Aucune famille sélectionnée</p>
          <p className="text-sm mt-1">Créez d'abord une famille depuis le tableau de bord</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-800">Membres — {selectedFamily.name}</h2>
            <p className="text-sm text-gray-500">
              {members.length} membre{members.length > 1 ? "s" : ""} enregistré{members.length > 1 ? "s" : ""}
            </p>
          </div>
          {canWrite && (
            <Button onClick={openAdd}>
              <Plus size={16} />
              Ajouter un membre
            </Button>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="animate-spin text-teal-600" size={36} />
          </div>
        ) : members.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-16 text-center">
            <div className="w-20 h-20 bg-teal-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Users size={36} className="text-teal-400" />
            </div>
            <h3 className="text-lg font-bold text-gray-700 mb-2">Aucun membre</h3>
            <p className="text-gray-400 mb-6">Ajoutez les membres de votre famille pour commencer le suivi médical.</p>
            {canWrite && (
              <Button onClick={openAdd}>
                <Plus size={16} />
                Ajouter un membre
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {members.map((m) => {
              const age = calculateAge(m.dateOfBirth);
              return (
                <div
                  key={m.id}
                  onDoubleClick={() => openView(m)}
                  className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 hover:shadow-md transition-all duration-200 cursor-pointer select-none"
                  title="Double-cliquez pour voir les détails"
                >
                  <div className="flex items-start justify-between mb-4">
                    <MemberAvatar member={m} size="lg" showName showAge />
                    <div className="flex gap-1" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                      {canEdit(m) && (
                        <button onClick={() => openEdit(m)} className="p-2 rounded-xl hover:bg-gray-100 text-gray-400 hover:text-teal-600 transition-colors">
                          <Pencil size={15} />
                        </button>
                      )}
                      {canDelete(m) && (
                        <button
                          onClick={() => deleteMember(m.id)}
                          disabled={deleting === m.id}
                          className="p-2 rounded-xl hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                        >
                          {deleting === m.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    {m.dateOfBirth && (
                      <div className="flex items-center gap-2 text-sm text-gray-600">
                        <span className="text-gray-400">🎂</span>
                        {formatDate(m.dateOfBirth)} {age !== null && <span className="text-gray-400">({age} ans)</span>}
                      </div>
                    )}
                    {m.gender && (
                      <div className="flex items-center gap-2 text-sm text-gray-600">
                        <Heart size={13} className="text-pink-400" />
                        {m.gender === "M" ? "Homme" : m.gender === "F" ? "Femme" : m.gender}
                      </div>
                    )}
                    {m.bloodType && (
                      <div className="flex items-center gap-2">
                        <Droplets size={13} className="text-red-400" />
                        <Badge variant="danger" className="text-xs">
                          {m.bloodType}
                        </Badge>
                      </div>
                    )}
                    {m.allergies && (
                      <div className="flex items-start gap-2 text-sm">
                        <AlertTriangle size={13} className="text-amber-500 mt-0.5 flex-shrink-0" />
                        <span className="text-gray-600 text-xs line-clamp-2">Allergies: {m.allergies}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal de détails du membre */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title="Détails du membre" size="lg">
        {viewing && (
          <div className="space-y-6">
            {/* En-tête */}
            <div className="flex items-center gap-4 bg-gradient-to-r from-teal-50 to-emerald-50 rounded-2xl p-5 border border-teal-100">
              <MemberAvatar member={viewing} size="xl" />
              <div className="flex-1">
                <h3 className="text-xl font-bold text-gray-800">
                  {viewing.firstName} {viewing.lastName}
                </h3>
                <p className="text-sm text-gray-500">
                  Membre depuis le {formatDate(viewing.createdAt)}
                </p>
              </div>
            </div>

            {/* Informations personnelles */}
            <div>
              <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Informations personnelles</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400 font-medium">Date de naissance</p>
                  <p className="text-sm font-semibold text-gray-700">
                    {viewing.dateOfBirth ? `${formatDate(viewing.dateOfBirth)} (${calculateAge(viewing.dateOfBirth)} ans)` : "Non renseignée"}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400 font-medium">Genre</p>
                  <p className="text-sm font-semibold text-gray-700">
                    {viewing.gender === "M" ? "Homme" : viewing.gender === "F" ? "Femme" : viewing.gender || "Non précisé"}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400 font-medium">Groupe sanguin</p>
                  {viewing.bloodType ? (
                    <Badge variant="danger">{viewing.bloodType}</Badge>
                  ) : (
                    <p className="text-sm font-semibold text-gray-700">Non connu</p>
                  )}
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400 font-medium">Couleur du profil</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className="w-5 h-5 rounded-full inline-block"
                      style={{ backgroundColor: viewing.avatarColor ?? "#3B82F6" }}
                    />
                    <span className="text-sm font-semibold text-gray-700">{viewing.avatarColor ?? "#3B82F6"}</span>
                  </div>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400 font-medium">Statut</p>
                  <p className="text-sm font-semibold text-gray-700">
                    {STATUS_OPTIONS.find((s) => s.value === viewing.status)?.label ?? "Connecté autonome"}
                  </p>
                </div>
              </div>
            </div>

            {/* Allergies */}
            {viewing.allergies && (
              <div>
                <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-2 flex items-center gap-2">
                  <AlertTriangle size={14} className="text-amber-500" /> Allergies connues
                </h4>
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
                  {viewing.allergies}
                </div>
              </div>
            )}

            {/* Notes médicales */}
            {viewing.notes && (
              <div>
                <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-2">Notes médicales</h4>
                <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm text-gray-700 whitespace-pre-wrap">
                  {viewing.notes}
                </div>
              </div>
            )}

            {/* Statistiques médicales */}
            <div>
              <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Activité médicale</h4>
              {statsLoading ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="animate-spin text-teal-600" size={24} />
                </div>
              ) : memberStats ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-blue-50 rounded-xl p-3 text-center">
                    <Calendar size={18} className="text-blue-500 mx-auto mb-1" />
                    <p className="text-2xl font-bold text-blue-700">{memberStats.appointments.length}</p>
                    <p className="text-xs text-blue-500 font-medium">Rendez-vous</p>
                  </div>
                  <div className="bg-amber-50 rounded-xl p-3 text-center">
                    <Syringe size={18} className="text-amber-500 mx-auto mb-1" />
                    <p className="text-2xl font-bold text-amber-700">{memberStats.vaccinations.length}</p>
                    <p className="text-xs text-amber-500 font-medium">Vaccinations</p>
                  </div>
                  <div className="bg-violet-50 rounded-xl p-3 text-center">
                    <Pill size={18} className="text-violet-500 mx-auto mb-1" />
                    <p className="text-2xl font-bold text-violet-700">{memberStats.treatments.length}</p>
                    <p className="text-xs text-violet-500 font-medium">Traitements</p>
                  </div>
                  <div className="bg-emerald-50 rounded-xl p-3 text-center">
                    <FileText size={18} className="text-emerald-500 mx-auto mb-1" />
                    <p className="text-2xl font-bold text-emerald-700">{memberStats.documents.length}</p>
                    <p className="text-xs text-emerald-500 font-medium">Documents</p>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Rôles Axe 2 sur ce dossier — UC-04, réservé aux Parents (A1/A2) */}
            {isParent && (
              <div>
                <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">
                  Rôles attribués sur ce dossier
                </h4>

                {docRolesLoading ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="animate-spin text-teal-600" size={20} />
                  </div>
                ) : (
                  <div className="space-y-2 mb-3">
                    {memberDocRoles.length === 0 ? (
                      <p className="text-sm text-gray-400 italic">Aucun rôle attribué pour l'instant.</p>
                    ) : (
                      memberDocRoles.map((r) => (
                        <div key={r.id} className="flex items-center justify-between bg-gray-50 rounded-xl p-3">
                          <div>
                            <p className="text-sm font-semibold text-gray-700">{r.userName}</p>
                            <p className="text-xs text-gray-400">{r.userEmail}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="info">{DOCUMENT_ROLE_LABELS[r.role] ?? r.role}</Badge>
                            <button
                              onClick={() => revokeDocumentRole(r.id)}
                              disabled={revokingRoleId === r.id}
                              className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                              title="Révoquer ce rôle"
                            >
                              {revokingRoleId === r.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                <div className="bg-gray-50 rounded-xl p-3 space-y-2">
                  <p className="text-xs font-semibold text-gray-600">Attribuer un nouveau rôle</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <Select value={newRoleUserId} onChange={(e) => setNewRoleUserId(e.target.value)}>
                      <option value="">Choisir une personne</option>
                      {familyAccounts.map((a) => (
                        <option key={a.userId} value={a.userId}>
                          {a.name} ({a.email})
                        </option>
                      ))}
                    </Select>
                    <Select value={newRoleType} onChange={(e) => setNewRoleType(e.target.value)}>
                      {DOCUMENT_ROLE_OPTIONS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button onClick={assignDocumentRole} loading={assigningRole} className="w-full">
                    <Plus size={15} />
                    Attribuer
                  </Button>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2 border-t border-gray-100">
              {canEdit(viewing) && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setViewing(null);
                    openEdit(viewing);
                  }}
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

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? "Modifier le membre" : "Ajouter un membre"} size="lg">
        <div className="space-y-4">
          {/* Avatar color picker */}
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

          <Select label="Statut" value={form.status} onChange={f("status")}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>

          <Textarea label="Allergies connues" placeholder="Pénicilline, arachides..." value={form.allergies} onChange={f("allergies")} />
          <Textarea label="Notes médicales" placeholder="Antécédents, conditions chroniques..." value={form.notes} onChange={f("notes")} />

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