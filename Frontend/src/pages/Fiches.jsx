import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { MemberAvatar } from "../components/members/MemberAvatar";
import { MemberContactDetails } from "../components/members/MemberContactFields";
import { MemberFormModal } from "../components/members/MemberFormModal";
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  FileHeart,
  Heart,
  Droplets,
  AlertTriangle,
  Calendar,
  FileText,
  Pill,
  Syringe,
  UserCircle,
  TreePine,
} from "lucide-react";
import { calculateAge, formatDate } from "../lib/utils";
import {
  FICHE_ROLE_OPTIONS,
  ficheRoleShortLabel,
  memberStatusLabel,
  myRelationSentence,
  myRelationBadge,
} from "../lib/roles";
import { kinshipLabel, memberSubtitle } from "../lib/kinship";
import toast from "react-hot-toast";

// Page "Fiches médicales" : les dossiers médicaux que l'utilisateur peut
// ouvrir (accès complet ou lecture). La liste de tous les membres du foyer,
// avec ou sans compte, est sur la page "Membres".
export default function FichesPage() {
  const {
    selectedFamily,
    isParent,
    isPrimaryAdmin,
    myRole,
    isDependent,
    members,
    myMember,
    membersLoading: loading,
    reloadMembers,
    canWriteMember,
  } = useFamily();
  const [searchParams, setSearchParams] = useSearchParams();

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [memberStats, setMemberStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  // Comptes de la famille — pour le sélecteur d'attribution d'un rôle sur la
  // fiche affichée (le titulaire de la fiche en est exclu).
  const [familyAccounts, setFamilyAccounts] = useState([]);
  // Rôles (Gestionnaire / Relais / Lecteur invité) attribués sur la fiche
  // actuellement affichée dans le détail.
  const [memberDocRoles, setMemberDocRoles] = useState([]);
  const [docRolesLoading, setDocRolesLoading] = useState(false);
  const [newRoleUserId, setNewRoleUserId] = useState("");
  const [newRoleType, setNewRoleType] = useState("gestionnaire");
  const [assigningRole, setAssigningRole] = useState(false);
  const [revokingRoleId, setRevokingRoleId] = useState(null);

  // Droits par fiche, calculés par le serveur (champ access) :
  // - lire : accès complet ou lecture ;
  // - modifier : accès complet ("full") ;
  // - supprimer : Parent avec accès complet, et fiche reliée à aucun compte
  //   (on ne supprime pas la fiche d'une personne qui a son compte) ;
  // - gérer les rôles de la fiche : sa propre fiche (hors Adolescent), ou
  //   Parent avec accès complet.
  const canRead = (m) => m?.access === "full" || m?.access === "read";
  const canEdit = (m) => m?.access === "full";
  const canDelete = (m) => isParent && m?.access === "full" && !m.hasAccount;
  const canManageRoles = (m) => (m?.isMine && !isDependent) || (isParent && m?.access === "full");

  const fiches = members.filter(canRead);
  // Membres dont l'utilisateur est seulement relais (pas d'accès au dossier)
  const relayOnly = members.filter((m) => !canRead(m) && (m.access === "relay" || m.myDocumentRole === "relais"));
  const relation = (m) => myRelationSentence(m, { myRole, isPrimaryAdmin });

  useEffect(() => {
    if (selectedFamily) loadMemberships();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFamily]);

  // Ouverture directe d'une fiche via ?fiche=ID (lien depuis la page Membres)
  const openedFromUrl = useRef(null);
  useEffect(() => {
    const id = searchParams.get("fiche");
    if (!id || loading || openedFromUrl.current === id) return;
    const m = members.find((mm) => String(mm.id) === id);
    if (m && canRead(m)) {
      openedFromUrl.current = id;
      // ?modifier=1 (lien « À compléter ») : formulaire de modification directement.
      if (searchParams.get("modifier") === "1" && canWriteMember(m.id)) {
        openEdit(m);
        searchParams.delete("fiche");
        searchParams.delete("modifier");
        setSearchParams(searchParams, { replace: true });
      } else {
        openView(m);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, members, loading]);

  // Garde la fiche affichée à jour après un rechargement des membres
  useEffect(() => {
    if (!viewing) return;
    const fresh = members.find((m) => m.id === viewing.id);
    if (fresh && fresh !== viewing) setViewing(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);

  const loadMemberships = async () => {
    if (!selectedFamily) return;
    try {
      const res = await fetch(`/api/family-memberships?familyId=${selectedFamily.id}`);
      const rows = await res.json();
      setFamilyAccounts(Array.isArray(rows) ? rows : []);
    } catch {
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
      toast.error("Choisissez un compte");
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
        toast.success("Rôle attribué sur cette fiche !");
        setNewRoleUserId("");
        loadDocumentRoles(viewing.id);
        reloadMembers();
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
      const res = await fetch(`/api/document-roles?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Rôle retiré");
        loadDocumentRoles(viewing.id);
        reloadMembers();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Erreur lors du retrait du rôle");
      }
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
    setMemberDocRoles([]);
    if (canManageRoles(m)) loadDocumentRoles(m.id);
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

  const closeView = () => {
    setViewing(null);
    // Retire ?fiche=ID de l'adresse pour ne pas rouvrir la fiche
    if (searchParams.get("fiche")) {
      openedFromUrl.current = null;
      setSearchParams({}, { replace: true });
    }
  };

  const openEdit = (m) => {
    setEditing(m);
    setShowForm(true);
  };

  const deleteFiche = async (id) => {
    if (!confirm("Supprimer ce membre, sa fiche et toutes ses données médicales ?")) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/members?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Membre et fiche supprimés");
        reloadMembers();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Erreur lors de la suppression");
      }
    } finally {
      setDeleting(null);
    }
  };

  const RelationBadge = ({ member }) => {
    const b = myRelationBadge(member);
    return b ? <Badge variant={b.variant}>{b.label}</Badge> : null;
  };

  const HolderLine = ({ member }) => (
    <p className="flex items-center gap-1.5 text-xs text-gray-500">
      <UserCircle size={13} className="text-gray-400" />
      {member.account ? `Titulaire : ${member.account.name}` : "Sans compte"}
    </p>
  );

  if (!selectedFamily) {
    return (
      <AppShell>
        <div className="text-center py-20 text-gray-400">
          <FileHeart size={48} className="mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">Aucune famille sélectionnée</p>
          <p className="text-sm mt-1">Créez d'abord une famille depuis le tableau de bord</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold text-gray-800">Fiches médicales — {selectedFamily.name}</h2>
          <p className="text-sm text-gray-500">
            Les dossiers médicaux que vous pouvez consulter : {fiches.length} sur {members.length} membre
            {members.length > 1 ? "s" : ""}.{" "}
            <Link to="/membres" className="text-teal-600 hover:underline font-medium">
              Voir tous les membres
            </Link>
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="animate-spin text-teal-600" size={36} />
          </div>
        ) : fiches.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-16 text-center">
            <div className="w-20 h-20 bg-teal-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <FileHeart size={36} className="text-teal-400" />
            </div>
            <h3 className="text-lg font-bold text-gray-700 mb-2">Aucune fiche à consulter</h3>
            <p className="text-gray-400 mb-6">
              Aucun dossier médical n'est partagé avec vous pour l'instant. Les membres du foyer sont listés sur la page
              Membres.
            </p>
            <Link to="/membres">
              <Button variant="outline">Voir les membres</Button>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {fiches.map((m) => {
              const age = calculateAge(m.dateOfBirth);
              return (
                <div
                  key={m.id}
                  onClick={() => openView(m)}
                  className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 hover:shadow-md transition-all duration-200 cursor-pointer select-none"
                  title="Cliquez pour ouvrir la fiche"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="space-y-2">
                      <MemberAvatar member={m} size="lg" showName />
                      <p className="text-xs text-gray-500">{memberSubtitle(m)}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {/* Lien de parenté vu par l'utilisateur courant */}
                        <Badge variant={m.isMine ? "success" : "default"}>{kinshipLabel(m, myMember, members)}</Badge>
                        <RelationBadge member={m} />
                        {m.relayPending && (
                          <Badge variant="warning" className="px-2 py-0.5 text-[11px]">
                            À relayer
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                      {canEdit(m) && (
                        <button
                          onClick={() => openEdit(m)}
                          title="Modifier la fiche"
                          className="p-2 rounded-xl hover:bg-gray-100 text-gray-400 hover:text-teal-600 transition-colors"
                        >
                          <Pencil size={15} />
                        </button>
                      )}
                      {canDelete(m) && (
                        <button
                          onClick={() => deleteFiche(m.id)}
                          disabled={deleting === m.id}
                          title="Supprimer ce membre et sa fiche"
                          className="p-2 rounded-xl hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                        >
                          {deleting === m.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1 mb-3">
                    <HolderLine member={m} />
                    <p className="text-xs text-teal-700">{relation(m)}</p>
                  </div>

                  <div className="space-y-2 pt-3 border-t border-gray-50">
                    {m.dateOfBirth && (
                      <div className="flex items-center gap-2 text-sm text-gray-600">
                        <span className="text-gray-400">🎂</span>
                        {formatDate(m.dateOfBirth)} {age !== null && <span className="text-gray-400">({age} ans)</span>}
                      </div>
                    )}
                    {m.gender && (
                      <div className="flex items-center gap-2 text-sm text-gray-600">
                        <Heart size={13} className="text-pink-400" />
                        {m.gender === "M" ? "Homme" : m.gender === "F" ? "Femme" : "Sexe à préciser"}
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
                        <span className="text-gray-600 text-xs line-clamp-2">Allergies : {m.allergies}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Fiches dont l'utilisateur est seulement relais : pas d'accès au
            dossier, uniquement les rendez-vous à transmettre (page Village) */}
        {!loading && relayOnly.length > 0 && (
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-800">
            <TreePine size={18} className="flex-shrink-0 mt-0.5" />
            <p>
              Vous êtes relais pour{" "}
              <strong>{relayOnly.map((m) => `${m.firstName} ${m.lastName}`).join(", ")}</strong> : vous les prévenez de
              leurs rendez-vous (date, heure et lieu seulement), sans accès à leur dossier.{" "}
              <Link to="/village" className="font-semibold underline">
                Ouvrir la page Village
              </Link>
            </p>
          </div>
        )}
      </div>

      {/* Détail d'une fiche médicale */}
      <Modal open={!!viewing} onClose={closeView} title="Fiche médicale" size="lg">
        {viewing && (
          <div className="space-y-6">
            {/* En-tête */}
            <div className="flex items-center gap-4 bg-gradient-to-r from-teal-50 to-emerald-50 rounded-2xl p-5 border border-teal-100">
              <MemberAvatar member={viewing} size="xl" />
              <div className="flex-1">
                <h3 className="text-xl font-bold text-gray-800">
                  {viewing.firstName} {viewing.lastName}
                </h3>
                <p className="text-sm text-gray-500">Fiche créée le {formatDate(viewing.createdAt)}</p>
                <div className="flex items-center gap-2 flex-wrap mt-1">
                  <Badge variant={viewing.isMine ? "success" : "default"}>
                    {kinshipLabel(viewing, myMember, members)}
                  </Badge>
                  <RelationBadge member={viewing} />
                  <span className="text-xs text-gray-500">
                    {viewing.account ? `Titulaire : ${viewing.account.name}` : "Sans compte — aucun compte relié à cette fiche"}
                  </span>
                </div>
                <p className="text-xs text-teal-700 mt-1">{relation(viewing)}</p>
              </div>
            </div>

            {/* Informations personnelles */}
            <div>
              <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Informations personnelles</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400 font-medium">Date de naissance</p>
                  <p className="text-sm font-semibold text-gray-700">
                    {viewing.dateOfBirth
                      ? `${formatDate(viewing.dateOfBirth)} (${memberSubtitle(viewing)})`
                      : "À préciser"}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400 font-medium">Sexe</p>
                  <p className="text-sm font-semibold text-gray-700">
                    {viewing.gender === "M" ? "Homme" : viewing.gender === "F" ? "Femme" : "À préciser"}
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
                  <p className="text-xs text-gray-400 font-medium">Statut de la personne</p>
                  <p className="text-sm font-semibold text-gray-700">{memberStatusLabel(viewing.status)}</p>
                </div>
              </div>
            </div>

            {/* Coordonnées, médecin traitant, contact d'urgence */}
            <MemberContactDetails member={viewing} />

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

            {/* Activité médicale */}
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

            {/* Accès à cette fiche — gérés par le titulaire de la fiche, ou par
                un administrateur / co-administrateur qui y a un accès complet */}
            {canManageRoles(viewing) && (
              <div>
                <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-1">Accès à cette fiche</h4>
                <p className="text-xs text-gray-500 mb-3">
                  Comptes à qui un rôle a été donné sur la fiche de {viewing.firstName}.
                </p>

                {docRolesLoading ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="animate-spin text-teal-600" size={20} />
                  </div>
                ) : (
                  <div className="space-y-2 mb-3">
                    {memberDocRoles.length === 0 ? (
                      <p className="text-sm text-gray-400 italic">Aucun rôle attribué sur cette fiche pour l'instant.</p>
                    ) : (
                      memberDocRoles.map((r) => (
                        <div key={r.id} className="flex items-center justify-between bg-gray-50 rounded-xl p-3">
                          <div>
                            <p className="text-sm font-semibold text-gray-700">{r.userName}</p>
                            <p className="text-xs text-gray-400">{r.userEmail}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant={r.role === "relais" ? "warning" : "info"}>{ficheRoleShortLabel(r.role)}</Badge>
                            <button
                              onClick={() => revokeDocumentRole(r.id)}
                              disabled={revokingRoleId === r.id}
                              className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                              title="Retirer ce rôle"
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
                  <p className="text-xs font-semibold text-gray-600">Donner un rôle sur cette fiche</p>
                  <div className="grid grid-cols-1 gap-2">
                    <Select value={newRoleUserId} onChange={(e) => setNewRoleUserId(e.target.value)}>
                      <option value="">Choisir un compte</option>
                      {/* Le titulaire de la fiche n'a pas besoin de rôle sur sa propre fiche */}
                      {familyAccounts
                        .filter((a) => a.linkedMemberId !== viewing.id)
                        .map((a) => (
                          <option key={a.userId} value={a.userId}>
                            {a.name} ({a.email})
                          </option>
                        ))}
                    </Select>
                    <Select value={newRoleType} onChange={(e) => setNewRoleType(e.target.value)}>
                      {FICHE_ROLE_OPTIONS.map((r) => (
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
                    const m = viewing;
                    closeView();
                    openEdit(m);
                  }}
                  className="flex-1"
                >
                  <Pencil size={15} />
                  Modifier la fiche
                </Button>
              )}
              <Button onClick={closeView} className="flex-1">
                Fermer
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <MemberFormModal open={showForm} onClose={() => setShowForm(false)} editing={editing} />
    </AppShell>
  );
}
