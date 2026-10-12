import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { useAuth } from "../context/AuthContext";
import { Button } from "../components/ui/Button";
import { Input, Select } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { UserCog, Mail, Trash2, Loader2, Clock, Shield, Plus, Link2, AlertTriangle } from "lucide-react";
import { formatDateTime } from "../lib/utils";
import {
  AGE_ACCESS_HELP,
  DEFAULT_ROLE_DURATION,
  FAMILY_ROLE_OPTIONS,
  FICHE_ROLE_OPTIONS,
  ROLE_DURATION_OPTIONS,
  accountLevelLabel,
  familyRoleLabel,
  familyRoleBadgeVariant,
  ficheRoleShortLabel,
} from "../lib/roles";
import toast from "react-hot-toast";
import { ReminderSettingsPanel } from "../components/village/ReminderSettingsPanel";

// Rôles d'un compte dans la famille, et rôles sur une fiche (optionnels,
// fixés avant l'envoi de l'invitation) : libellés communs dans lib/roles.js.
// Le Titulaire n'est pas un rôle attribuable : c'est le compte relié à la fiche.
// Seuls deux choix : "Membre de la famille" (niveau d'accès déduit de l'âge
// par le serveur) ou "Parent — co-administrateur" (réservé à A1).
const ROLE_OPTIONS = FAMILY_ROLE_OPTIONS;

// Valeur du sélecteur de rôle d'un compte existant : "parent" ou "member"
// (un membre adolescent ou majeur est un simple "Membre").
const roleSelectValue = (role) => (role === "parent" ? "parent" : "member");
// Rôle envoyé au serveur : "Membre" correspond au rôle "adult" ; le serveur
// ramène en lecture seule un compte de moins de 18 ans.
const roleForServer = (value) => (value === "parent" ? "parent" : "adult");

export default function FamilySettingsPage() {
  // Les fiches de la famille (avec l'accès de l'utilisateur sur chacune)
  // viennent du contexte ; on les recharge après tout changement de liaison
  // compte ↔ fiche.
  const { selectedFamily, members: familyMembers, reloadMembers, reloadMembership, isPrimaryAdmin, loadFamilies } =
    useFamily();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [memberships, setMemberships] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(false);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteLinkedMemberId, setInviteLinkedMemberId] = useState("");
  const [inviteDocumentMemberId, setInviteDocumentMemberId] = useState("");
  const [inviteDocumentRole, setInviteDocumentRole] = useState("");
  // Lecteur invité (R4) : durée d'accès obligatoire, comptée à l'acceptation.
  const [inviteRoleDuration, setInviteRoleDuration] = useState(DEFAULT_ROLE_DURATION);
  const [inviting, setInviting] = useState(false);

  const [updatingId, setUpdatingId] = useState(null);
  const [removingId, setRemovingId] = useState(null);

  // Fiche choisie, par compte, pour relier un compte sans fiche à sa fiche
  const [linkSelection, setLinkSelection] = useState({}); // { [membershipId]: memberId }

  const myMembership = memberships.find((m) => m.userId === user?.id);
  const isParent = myMembership?.role === "parent";
  // Nommer un co-administrateur (rôle Parent) est réservé à A1 (UC-05).
  const assignableRoles = myMembership?.isPrimaryAdmin
    ? ROLE_OPTIONS
    : ROLE_OPTIONS.filter((r) => r.value !== "parent");

  // Fiches pouvant devenir celle d'un compte : accès complet et reliées à
  // aucun compte pour l'instant.
  const linkableFiches = familyMembers.filter((m) => m.access === "full" && !m.hasAccount);
  // Dossiers sur lesquels l'utilisateur peut attribuer un rôle : sa propre
  // fiche, ou toute fiche en accès complet s'il est Parent.
  const manageableFiches = familyMembers.filter(
    (m) => (m.isMine && myMembership?.role !== "dependent") || (isParent && m.access === "full")
  );

  useEffect(() => {
    if (selectedFamily) load();
  }, [selectedFamily]);

  const load = async () => {
    if (!selectedFamily) return;
    setLoading(true);
    try {
      const membershipsRes = await fetch(`/api/family-memberships?familyId=${selectedFamily.id}`);
      const membershipsData = await membershipsRes.json().catch(() => null);
      const membershipList = membershipsRes.ok && Array.isArray(membershipsData) ? membershipsData : [];
      if (!membershipsRes.ok) toast.error(membershipsData?.error || "Impossible de charger les comptes de la famille");
      setMemberships(membershipList);

      // Seul un Parent voit les invitations en attente — on vérifie le rôle
      // directement sur la réponse fraîche (pas sur l'état, pas encore à jour).
      const mine = membershipList.find((m) => m.userId === user?.id);
      if (mine?.role === "parent") {
        const invitationsRes = await fetch(`/api/invitations?familyId=${selectedFamily.id}`);
        const invitationsData = await invitationsRes.json().catch(() => null);
        if (!invitationsRes.ok) toast.error(invitationsData?.error || "Impossible de charger les invitations");
        setInvitations(invitationsRes.ok && Array.isArray(invitationsData) ? invitationsData : []);
      } else {
        setInvitations([]);
      }
    } catch {
      toast.error("Impossible de charger les comptes de la famille. Vérifiez votre connexion.");
    } finally {
      setLoading(false);
    }
  };

  const sendInvite = async () => {
    if (!inviteEmail.trim()) {
      toast.error("Adresse courriel requise");
      return;
    }
    if ((inviteDocumentMemberId && !inviteDocumentRole) || (!inviteDocumentMemberId && inviteDocumentRole)) {
      toast.error("Choisissez à la fois une fiche et un rôle sur cette fiche, ou aucun des deux");
      return;
    }
    setInviting(true);
    try {
      const res = await fetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          familyId: selectedFamily.id,
          email: inviteEmail,
          role: inviteRole,
          linkedMemberId: inviteLinkedMemberId || undefined,
          documentMemberId: inviteDocumentMemberId || undefined,
          documentRole: inviteDocumentRole || undefined,
          documentRoleDuration: inviteDocumentRole === "lecteur_invite" ? inviteRoleDuration : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Échec de l'invitation");
        return;
      }
      toast.success("Invitation envoyée par courriel !");
      setShowInvite(false);
      setInviteEmail("");
      setInviteRole("member");
      setInviteLinkedMemberId("");
      setInviteDocumentMemberId("");
      setInviteDocumentRole("");
      setInviteRoleDuration(DEFAULT_ROLE_DURATION);
      load();
    } finally {
      setInviting(false);
    }
  };

  const applyRoleChange = async (membershipId, role, linkedMemberId) => {
    setUpdatingId(membershipId);
    try {
      const res = await fetch("/api/family-memberships", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: membershipId, role, linkedMemberId }),
      });
      if (res.ok) {
        toast.success("Rôle mis à jour");
        load();
        // La liaison compte ↔ fiche a pu changer (hasAccount, accès...)
        reloadMembers();
        reloadMembership();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Échec de la mise à jour");
      }
    } finally {
      setUpdatingId(null);
    }
  };

  // Appelé quand l'Admin change le rôle depuis le menu déroulant de la liste
  // ("member" → rôle "adult" côté serveur, qui déduit le niveau de l'âge).
  const handleRoleSelect = (membership, value) => {
    applyRoleChange(membership.id, roleForServer(value), membership.linkedMemberId);
  };

  // Relie un compte (sans fiche) à une fiche existante — même appel que le
  // changement de rôle, en conservant le rôle actuel.
  const linkFiche = async (membership) => {
    const linkedMemberId = linkSelection[membership.id];
    if (!linkedMemberId) {
      toast.error("Choisissez la fiche de cette personne");
      return;
    }
    setUpdatingId(membership.id);
    try {
      const res = await fetch("/api/family-memberships", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: membership.id, role: roleForServer(membership.role), linkedMemberId }),
      });
      if (res.ok) {
        toast.success("Fiche reliée à ce compte");
        setLinkSelection((prev) => ({ ...prev, [membership.id]: "" }));
        load();
        reloadMembers();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Impossible de relier cette fiche");
      }
    } finally {
      setUpdatingId(null);
    }
  };

  // Retrait d'un compte (UC-06) : la confirmation se fait dans une fenêtre
  // qui liste d'abord les dossiers dont il est le SEUL gestionnaire ; pour
  // chacun, on choisit à qui en confier la gestion (par défaut : soi-même).
  // removal = { membership, fiches, candidates, choices: { [memberId]: userId } }
  const [removal, setRemoval] = useState(null);

  const openRemoval = async (membership) => {
    setRemovingId(membership.id);
    try {
      const res = await fetch(`/api/family-memberships/${membership.id}/managed-fiches`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        toast.error(data?.error || "Impossible de préparer le retrait de ce compte");
        return;
      }
      const choices = Object.fromEntries(data.fiches.map((f) => [f.id, String(data.defaultUserId)]));
      setRemoval({ membership, fiches: data.fiches, candidates: data.candidates, choices });
    } catch {
      toast.error("Impossible de préparer le retrait de ce compte. Vérifiez votre connexion.");
    } finally {
      setRemovingId(null);
    }
  };

  const confirmRemoval = async () => {
    if (!removal) return;
    const { membership, fiches, choices } = removal;
    if (fiches.some((f) => !choices[f.id])) {
      toast.error("Choisissez à qui confier chaque dossier");
      return;
    }
    setRemovingId(membership.id);
    try {
      const res = await fetch(`/api/family-memberships?id=${membership.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reassignments: fiches.map((f) => ({ memberId: f.id, userId: Number(choices[f.id]) })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Un dossier a pu changer entre-temps : on recharge la liste.
        if (data.code === "REASSIGNMENT_REQUIRED") {
          toast.error(data.error);
          openRemoval(membership);
          return;
        }
        toast.error(data.error || "Échec du retrait de l'accès");
        return;
      }
      toast.success(
        fiches.length > 0
          ? `Accès retiré — ${fiches.length} dossier${fiches.length > 1 ? "s" : ""} confié${fiches.length > 1 ? "s" : ""}`
          : "Accès retiré"
      );
      setRemoval(null);
      load();
      reloadMembers();
    } finally {
      setRemovingId(null);
    }
  };

  const [cancellingId, setCancellingId] = useState(null);

  const cancelInvitation = async (id) => {
    if (!confirm("Annuler cette invitation ?")) return;
    setCancellingId(id);
    try {
      const res = await fetch(`/api/invitations?id=${id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Échec de l'annulation de l'invitation");
        return;
      }
      toast.success("Invitation annulée");
      load();
    } catch {
      toast.error("Échec de l'annulation de l'invitation. Vérifiez votre connexion.");
    } finally {
      setCancellingId(null);
    }
  };

  // Suppression de l'espace familial — réservée à l'administrateur familial,
  // avec double confirmation : ouverture d'une fenêtre puis saisie du nom.
  const [showDeleteFamily, setShowDeleteFamily] = useState(false);
  const [deleteFamilyName, setDeleteFamilyName] = useState("");
  const [deletingFamily, setDeletingFamily] = useState(false);
  const deleteFamilyConfirmed =
    !!selectedFamily && deleteFamilyName.trim().toLowerCase() === selectedFamily.name.trim().toLowerCase();

  const closeDeleteFamily = () => {
    setShowDeleteFamily(false);
    setDeleteFamilyName("");
  };

  const deleteFamily = async () => {
    if (!deleteFamilyConfirmed) return;
    setDeletingFamily(true);
    try {
      const id = selectedFamily.id;
      const res = await fetch(`/api/families?id=${id}&familyId=${id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Échec de la suppression de l'espace familial");
        return;
      }
      toast.success("Espace familial supprimé");
      closeDeleteFamily();
      await loadFamilies();
      navigate("/dashboard");
    } catch {
      toast.error("Échec de la suppression de l'espace familial. Vérifiez votre connexion.");
    } finally {
      setDeletingFamily(false);
    }
  };

  const memberName = (id) => {
    const m = familyMembers.find((mm) => mm.id === id);
    return m ? `${m.firstName} ${m.lastName}` : null;
  };

  if (!selectedFamily) {
    return (
      <AppShell>
        <div className="text-center py-20 text-gray-400">
          <UserCog size={48} className="mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">Aucune famille sélectionnée</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-800">Comptes & invitations — {selectedFamily.name}</h2>
            <p className="text-sm text-gray-500">
              {memberships.length} compte{memberships.length > 1 ? "s" : ""} dans la famille
              {!isParent && " · lecture seule (modification réservée aux administrateurs)"}
            </p>
          </div>
          {isParent && (
            <Button onClick={() => setShowInvite(true)}>
              <Plus size={16} />
              Inviter quelqu&apos;un
            </Button>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="animate-spin text-teal-600" size={36} />
          </div>
        ) : (
          <>
            {/* Comptes avec accès */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
                <Shield size={16} className="text-teal-600" />
                <h3 className="font-bold text-gray-800 text-sm">Comptes de la famille</h3>
              </div>
              <div className="divide-y divide-gray-50">
                {memberships.map((m) => (
                  <div key={m.id} className="px-6 py-4 flex items-center gap-4 flex-wrap">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-teal-400 to-blue-500 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                      {m.name?.[0]?.toUpperCase() ?? "?"}
                    </div>
                    <div className="flex-1 min-w-[160px]">
                      <p className="font-semibold text-gray-800 text-sm">
                        {m.name} {m.userId === user?.id && <span className="text-gray-400 font-normal">(vous)</span>}
                      </p>
                      <p className="text-xs text-gray-500">{m.email}</p>
                      {/* Niveau d'accès effectif (déduit de l'âge par le serveur) */}
                      <p className="text-xs text-gray-600 mt-0.5">{accountLevelLabel(m.role, m.isPrimaryAdmin, m.age)}</p>
                      {/* Fiche de ce compte (dont il est titulaire), quel que soit son rôle */}
                      {m.linkedMemberId ? (
                        <p className="text-xs text-teal-600 mt-0.5">
                          Fiche : {memberName(m.linkedMemberId) ?? "fiche non visible"}
                        </p>
                      ) : (
                        <p className="text-xs text-gray-400 mt-0.5 italic">N'a pas encore créé sa fiche</p>
                      )}
                      {/* Un Parent peut relier un autre compte à sa fiche (pas sa
                          propre ligne : chacun désigne sa fiche lui-même) */}
                      {isParent && !m.linkedMemberId && m.userId !== user?.id && linkableFiches.length > 0 && (
                        <div className="flex items-center gap-2 mt-2">
                          <Select
                            value={linkSelection[m.id] ?? ""}
                            onChange={(e) => setLinkSelection((prev) => ({ ...prev, [m.id]: e.target.value }))}
                            className="!py-1.5 !text-sm w-auto"
                          >
                            <option value="">Choisir sa fiche</option>
                            {linkableFiches.map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.firstName} {f.lastName}
                              </option>
                            ))}
                          </Select>
                          <Button size="sm" variant="outline" onClick={() => linkFiche(m)} loading={updatingId === m.id}>
                            <Link2 size={14} />
                            Relier
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* Le rôle d'un autre Parent, comme celui de l'administrateur
                        familial, n'est pas modifiable (refusé par le serveur) : simple badge. */}
                    {isParent && !m.isPrimaryAdmin && !(m.role === "parent" && m.userId !== user?.id) ? (
                      <Select
                        value={roleSelectValue(m.role)}
                        onChange={(e) => handleRoleSelect(m, e.target.value)}
                        disabled={updatingId === m.id}
                        className="!py-1.5 !text-sm w-auto"
                      >
                        {(m.role === "parent" ? ROLE_OPTIONS : assignableRoles).map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.value === "parent" && m.role === "parent" ? familyRoleLabel("parent", m.isPrimaryAdmin) : r.label}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge variant={familyRoleBadgeVariant(m.role, m.isPrimaryAdmin)}>{familyRoleLabel(m.role, m.isPrimaryAdmin)}</Badge>
                    )}

                    {isParent && (
                      <button
                        onClick={() => openRemoval(m)}
                        disabled={removingId === m.id || m.userId === user?.id || m.isPrimaryAdmin}
                        title={
                          m.userId === user?.id
                            ? "Vous ne pouvez pas vous retirer vous-même"
                            : m.isPrimaryAdmin
                              ? "L'administrateur familial ne peut pas être retiré"
                              : "Retirer l'accès"
                        }
                        aria-label={`Retirer l'accès de ${m.name ?? "ce compte"}`}
                        className="p-2 rounded-xl hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                      >
                        {removingId === m.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Invitations en attente */}
            {invitations.length > 0 && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
                  <Clock size={16} className="text-amber-600" />
                  <h3 className="font-bold text-gray-800 text-sm">Invitations en attente</h3>
                </div>
                <div className="divide-y divide-gray-50">
                  {invitations.map((inv) => (
                    <div key={inv.id} className="px-6 py-4 flex items-center gap-4 flex-wrap">
                      <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center flex-shrink-0">
                        <Mail size={16} className="text-amber-600" />
                      </div>
                      <div className="flex-1 min-w-[160px]">
                        <p className="font-semibold text-gray-800 text-sm">{inv.email}</p>
                        <p className="text-xs text-gray-500">
                          Invité(e) le {formatDateTime(inv.createdAt)} · expire le {formatDateTime(inv.expiresAt)}
                        </p>
                        {memberName(inv.linkedMemberId) && (
                          <p className="text-xs text-amber-600 mt-0.5">Fiche liée : {memberName(inv.linkedMemberId)}</p>
                        )}
                        {inv.documentMemberId && inv.documentRole && (
                          <p className="text-xs text-teal-600 mt-0.5">
                            {ficheRoleShortLabel(inv.documentRole)} sur la fiche de {memberName(inv.documentMemberId)}
                          </p>
                        )}
                      </div>
                      <Badge variant={familyRoleBadgeVariant(inv.role)}>{familyRoleLabel(inv.role)}</Badge>
                      {isParent && (
                        <button
                          type="button"
                          onClick={() => cancelInvitation(inv.id)}
                          disabled={cancellingId === inv.id}
                          title="Annuler l'invitation"
                          aria-label={`Annuler l'invitation de ${inv.email}`}
                          className="p-2 rounded-xl hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors disabled:opacity-30"
                        >
                          {cancellingId === inv.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Règles d'escalade des rappels du Village (UC-08) — parents seulement */}
            {isParent && <ReminderSettingsPanel familyId={selectedFamily.id} />}

            {/* Zone sensible — suppression de l'espace, réservée à l'administrateur familial */}
            {isPrimaryAdmin && (
              <div className="bg-white rounded-2xl shadow-sm border border-red-100 overflow-hidden">
                <div className="px-6 py-4 border-b border-red-100 flex items-center gap-2">
                  <AlertTriangle size={16} className="text-red-500" />
                  <h3 className="font-bold text-gray-800 text-sm">Zone sensible</h3>
                </div>
                <div className="px-6 py-4 flex flex-col sm:flex-row sm:items-center gap-4">
                  <p className="flex-1 text-sm text-gray-600">
                    Supprimer l&apos;espace familial efface définitivement toutes ses fiches, leurs données médicales
                    et leurs documents, et retire l&apos;accès de tous les comptes de la famille.
                  </p>
                  <Button variant="danger" onClick={() => setShowDeleteFamily(true)}>
                    <Trash2 size={15} />
                    Supprimer l&apos;espace familial
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <Modal open={!!removal} onClose={() => setRemoval(null)} title="Retirer ce compte de la famille">
        {removal && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              <strong>{removal.membership.name}</strong> perdra l&apos;accès à la famille {selectedFamily.name}. Sa fiche
              sera archivée s&apos;il est majeur ; ses rôles sur les dossiers et ses notifications disparaîtront.
            </p>
            {removal.fiches.length > 0 && (
              <div className="border border-amber-200 bg-amber-50 rounded-xl p-3 space-y-3">
                <p className="text-sm text-amber-900">
                  {removal.membership.name} est le seul gestionnaire de{" "}
                  {removal.fiches.length > 1 ? `ces ${removal.fiches.length} dossiers` : "ce dossier"}. Choisissez à qui
                  en confier la gestion avant de le retirer :
                </p>
                {removal.fiches.map((fiche) => (
                  <Select
                    key={fiche.id}
                    label={`Dossier de ${fiche.firstName} ${fiche.lastName}`}
                    value={removal.choices[fiche.id] ?? ""}
                    onChange={(e) =>
                      setRemoval((prev) => ({ ...prev, choices: { ...prev.choices, [fiche.id]: e.target.value } }))
                    }
                  >
                    {removal.candidates.map((c) => (
                      <option key={c.userId} value={c.userId}>
                        {c.name}
                        {c.userId === user?.id ? " (vous)" : ""}
                      </option>
                    ))}
                  </Select>
                ))}
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <Button variant="ghost" onClick={() => setRemoval(null)} className="flex-1">
                Annuler
              </Button>
              <Button
                variant="danger"
                onClick={confirmRemoval}
                loading={removingId === removal.membership.id}
                className="flex-1"
              >
                Retirer
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={showDeleteFamily} onClose={closeDeleteFamily} title="Supprimer l'espace familial">
        <div className="space-y-4">
          <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
            <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold">Cette action est définitive.</p>
              <p>
                L&apos;espace <strong>{selectedFamily.name}</strong>, toutes ses fiches, toutes les données médicales et
                tous les documents seront supprimés. Les autres comptes perdront l&apos;accès à cette famille.
              </p>
            </div>
          </div>
          <Input
            label={`Tapez le nom de la famille (« ${selectedFamily.name} ») pour confirmer`}
            value={deleteFamilyName}
            onChange={(e) => setDeleteFamilyName(e.target.value)}
            autoComplete="off"
          />
          <div className="flex gap-3 pt-2">
            <Button variant="ghost" onClick={closeDeleteFamily} className="flex-1">
              Annuler
            </Button>
            <Button
              variant="danger"
              onClick={deleteFamily}
              loading={deletingFamily}
              disabled={!deleteFamilyConfirmed}
              className="flex-1"
            >
              Supprimer définitivement
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={showInvite} onClose={() => setShowInvite(false)} title="Inviter quelqu'un">
        <div className="space-y-4">
          <Input
            label="Adresse courriel *"
            type="email"
            placeholder="nom@exemple.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <Select
            label="Rôle dans la famille *"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
          >
            {assignableRoles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-gray-500 -mt-2">{AGE_ACCESS_HELP}</p>

          {/* Fiche de la personne invitée : optionnelle (elle pourra créer la
              sienne à son arrivée). Seules les fiches non reliées à un compte
              et en accès complet. */}
          <Select
            label="Fiche de cette personne"
            value={inviteLinkedMemberId}
            onChange={(e) => {
              setInviteLinkedMemberId(e.target.value);
              if (e.target.value && e.target.value === inviteDocumentMemberId) {
                setInviteDocumentMemberId("");
                setInviteDocumentRole("");
              }
            }}
          >
            <option value="">Aucune — elle créera sa fiche à son arrivée</option>
            {linkableFiches.map((m) => (
              <option key={m.id} value={m.id}>
                {m.firstName} {m.lastName}
              </option>
            ))}
          </Select>

          {/* Rôle sur une fiche — optionnel, fixé avant l'envoi comme le rôle
              dans la famille, rend l'invitation explicite. */}
          <div className="border border-gray-200 rounded-xl p-3 space-y-3">
            <p className="text-xs font-semibold text-gray-600">
              Rôle sur la fiche d&apos;un membre (optionnel)
            </p>
            <Select
              label="Fiche concernée"
              value={inviteDocumentMemberId}
              onChange={(e) => setInviteDocumentMemberId(e.target.value)}
            >
              <option value="">Aucune — rôle dans la famille uniquement</option>
              {manageableFiches
                .filter((m) => m.id.toString() !== inviteLinkedMemberId)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.firstName} {m.lastName}
                  </option>
                ))}
            </Select>
            {inviteDocumentMemberId && (
              <Select
                label="Rôle sur cette fiche *"
                value={inviteDocumentRole}
                onChange={(e) => setInviteDocumentRole(e.target.value)}
              >
                <option value="">Choisir un rôle</option>
                {FICHE_ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            )}
            {inviteDocumentMemberId && inviteDocumentRole === "lecteur_invite" && (
              <Select
                label="Durée de l'accès *"
                value={inviteRoleDuration}
                onChange={(e) => setInviteRoleDuration(e.target.value)}
              >
                {ROLE_DURATION_OPTIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label} à compter de son arrivée
                  </option>
                ))}
              </Select>
            )}
          </div>

          <p className="text-xs text-gray-400 bg-gray-50 rounded-xl px-3 py-2">
            💡 Un courriel d&apos;invitation est toujours envoyé, avec un lien sécurisé valide 30 jours — même si
            cette personne a déjà un compte SunuSanté Famille.
          </p>
          <div className="flex gap-3 pt-2">
            <Button variant="ghost" onClick={() => setShowInvite(false)} className="flex-1">
              Annuler
            </Button>
            <Button onClick={sendInvite} loading={inviting} className="flex-1">
              Envoyer l&apos;invitation
            </Button>
          </div>
        </div>
      </Modal>

    </AppShell>
  );
}