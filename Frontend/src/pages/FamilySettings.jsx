import { useEffect, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { useAuth } from "../context/AuthContext";
import { Button } from "../components/ui/Button";
import { Input, Select } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { UserCog, Mail, Trash2, Loader2, Clock, Shield, Plus, Link2 } from "lucide-react";
import { formatDateTime } from "../lib/utils";
import toast from "react-hot-toast";

const ROLE_OPTIONS = [
  { value: "parent", label: "Parent" },
  { value: "adult", label: "Membre adulte" },
  { value: "dependent", label: "Personne dépendante" },
];

// Axe 2 du modèle d'acteurs — rôle de dossier optionnel, fixé en même temps
// que le rôle d'espace, avant l'envoi de l'invitation (§6.2/6.3). Le
// Titulaire n'en fait pas partie : c'est le compte relié à la fiche.
const DOCUMENT_ROLE_OPTIONS = [
  { value: "gestionnaire", label: "Gestionnaire (saisit et administre)" },
  { value: "relais", label: "Relais (rappel à transmettre uniquement)" },
  { value: "lecteur_invite", label: "Lecteur invité (consultation seule)" },
];
const documentRoleLabel = (role) => DOCUMENT_ROLE_OPTIONS.find((r) => r.value === role)?.label.split(" (")[0] ?? role;

const roleLabel = (role) => ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role;
const roleBadgeVariant = (role) => (role === "parent" ? "danger" : role === "dependent" ? "warning" : "info");

export default function FamilySettingsPage() {
  // Les fiches de la famille (avec l'accès de l'utilisateur sur chacune)
  // viennent du contexte ; on les recharge après tout changement de liaison
  // compte ↔ fiche.
  const { selectedFamily, members: familyMembers, reloadMembers, reloadMembership } = useFamily();
  const { user } = useAuth();

  const [memberships, setMemberships] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(false);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("adult");
  const [inviteLinkedMemberId, setInviteLinkedMemberId] = useState("");
  const [inviteDocumentMemberId, setInviteDocumentMemberId] = useState("");
  const [inviteDocumentRole, setInviteDocumentRole] = useState("");
  const [inviting, setInviting] = useState(false);

  const [updatingId, setUpdatingId] = useState(null);
  const [removingId, setRemovingId] = useState(null);

  // Changement de rôle vers "Dépendant" depuis la liste des comptes — demande
  // la fiche liée dans une petite modale dédiée avant de valider.
  const [roleChangeTarget, setRoleChangeTarget] = useState(null); // { membershipId }
  const [roleChangeLinkedMemberId, setRoleChangeLinkedMemberId] = useState("");

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
      const membershipsData = await membershipsRes.json();
      setMemberships(membershipsData);

      // Seul un Parent voit les invitations en attente — on vérifie le rôle
      // directement sur la réponse fraîche (pas sur l'état, pas encore à jour).
      const mine = membershipsData.find((m) => m.userId === user?.id);
      if (mine?.role === "parent") {
        const invitationsRes = await fetch(`/api/invitations?familyId=${selectedFamily.id}`);
        setInvitations(await invitationsRes.json());
      } else {
        setInvitations([]);
      }
    } finally {
      setLoading(false);
    }
  };

  const sendInvite = async () => {
    if (!inviteEmail.trim()) {
      toast.error("Email requis");
      return;
    }
    if (inviteRole === "dependent" && !inviteLinkedMemberId) {
      toast.error("Choisissez la fiche membre correspondant à cette personne");
      return;
    }
    if ((inviteDocumentMemberId && !inviteDocumentRole) || (!inviteDocumentMemberId && inviteDocumentRole)) {
      toast.error("Choisissez à la fois un dossier et un rôle de dossier, ou aucun des deux");
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
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Échec de l'invitation");
        return;
      }
      toast.success("Invitation envoyée par email !");
      setShowInvite(false);
      setInviteEmail("");
      setInviteRole("adult");
      setInviteLinkedMemberId("");
      setInviteDocumentMemberId("");
      setInviteDocumentRole("");
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
  const handleRoleSelect = (membership, newRole) => {
    if (newRole === "dependent" && !membership.linkedMemberId) {
      // Il faut choisir la fiche liée avant de valider — ouvre la mini-modale
      setRoleChangeTarget({ membershipId: membership.id });
      setRoleChangeLinkedMemberId("");
      return;
    }
    applyRoleChange(membership.id, newRole, membership.linkedMemberId);
  };

  const confirmRoleChangeToDependent = async () => {
    if (!roleChangeLinkedMemberId) {
      toast.error("Choisissez la fiche membre correspondant à cette personne");
      return;
    }
    await applyRoleChange(roleChangeTarget.membershipId, "dependent", roleChangeLinkedMemberId);
    setRoleChangeTarget(null);
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
        body: JSON.stringify({ id: membership.id, role: membership.role, linkedMemberId }),
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

  const removeAccess = async (membershipId) => {
    if (!confirm("Retirer l'accès de cette personne à la famille ?")) return;
    setRemovingId(membershipId);
    try {
      const res = await fetch(`/api/family-memberships?id=${membershipId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Échec du retrait de l'accès");
        return;
      }
      toast.success("Accès retiré");
      load();
      reloadMembers();
    } finally {
      setRemovingId(null);
    }
  };

  const cancelInvitation = async (id) => {
    if (!confirm("Annuler cette invitation ?")) return;
    await fetch(`/api/invitations?id=${id}`, { method: "DELETE" });
    toast.success("Invitation annulée");
    load();
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
            <h2 className="text-xl font-bold text-gray-800">Accès & rôles — {selectedFamily.name}</h2>
            <p className="text-sm text-gray-500">
              {memberships.length} compte{memberships.length > 1 ? "s" : ""} avec accès
              {!isParent && " · lecture seule (réservé aux Parents pour modifier)"}
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
                <h3 className="font-bold text-gray-800 text-sm">Comptes ayant accès</h3>
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
                      {/* Fiche de ce compte (dont il est titulaire), quel que soit son rôle */}
                      {m.linkedMemberId ? (
                        <p className="text-xs text-teal-600 mt-0.5">
                          Fiche : {memberName(m.linkedMemberId) ?? "fiche non visible"}
                        </p>
                      ) : (
                        <p className="text-xs text-gray-400 mt-0.5 italic">Pas encore de fiche</p>
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

                    {/* Le rôle d'un autre Parent n'est pas modifiable (refusé par le serveur) : simple badge. */}
                    {isParent && !(m.role === "parent" && m.userId !== user?.id) ? (
                      <Select
                        value={m.role}
                        onChange={(e) => handleRoleSelect(m, e.target.value)}
                        disabled={updatingId === m.id}
                        className="!py-1.5 !text-sm w-auto"
                      >
                        {(m.role === "parent" ? ROLE_OPTIONS : assignableRoles).map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge variant={roleBadgeVariant(m.role)}>{roleLabel(m.role)}</Badge>
                    )}

                    {isParent && (
                      <button
                        onClick={() => removeAccess(m.id)}
                        disabled={removingId === m.id || m.userId === user?.id || m.isPrimaryAdmin}
                        title={
                          m.userId === user?.id
                            ? "Vous ne pouvez pas vous retirer vous-même"
                            : m.isPrimaryAdmin
                              ? "L'administrateur familial ne peut pas être retiré"
                              : "Retirer l'accès"
                        }
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
                            {documentRoleLabel(inv.documentRole)} du dossier de {memberName(inv.documentMemberId)}
                          </p>
                        )}
                      </div>
                      <Badge variant={roleBadgeVariant(inv.role)}>{roleLabel(inv.role)}</Badge>
                      {isParent && (
                        <button
                          onClick={() => cancelInvitation(inv.id)}
                          className="p-2 rounded-xl hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <Modal open={showInvite} onClose={() => setShowInvite(false)} title="Inviter quelqu'un">
        <div className="space-y-4">
          <Input
            label="Email *"
            type="email"
            placeholder="exemple@email.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <Select
            label="Rôle *"
            value={inviteRole}
            onChange={(e) => {
              setInviteRole(e.target.value);
              // Pas de rôle de dossier proposé pour une personne dépendante
              if (e.target.value === "dependent") {
                setInviteDocumentMemberId("");
                setInviteDocumentRole("");
              }
            }}
          >
            {assignableRoles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>

          {/* Fiche de la personne invitée : optionnelle (elle pourra créer la
              sienne à son arrivée), obligatoire pour une personne dépendante.
              Seules les fiches non reliées à un compte et en accès complet. */}
          <Select
            label={inviteRole === "dependent" ? "Fiche de cette personne *" : "Fiche de cette personne"}
            value={inviteLinkedMemberId}
            onChange={(e) => {
              setInviteLinkedMemberId(e.target.value);
              if (e.target.value && e.target.value === inviteDocumentMemberId) {
                setInviteDocumentMemberId("");
                setInviteDocumentRole("");
              }
            }}
          >
            <option value="">
              {inviteRole === "dependent"
                ? "Sélectionnez une fiche existante"
                : "Aucune — elle créera sa fiche à son arrivée"}
            </option>
            {linkableFiches.map((m) => (
              <option key={m.id} value={m.id}>
                {m.firstName} {m.lastName}
              </option>
            ))}
          </Select>
          {inviteRole === "dependent" && linkableFiches.length === 0 && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded-xl px-3 py-2">
              ⚠️ Créez d&apos;abord la fiche de cette personne depuis la page Membres.
            </p>
          )}

          {/* Rôle de dossier (Axe 2) — optionnel, fixé avant l'envoi comme le
              rôle d'espace (§6.2/6.3), rend l'invitation explicite. */}
          {inviteRole !== "dependent" && (
            <div className="border border-gray-200 rounded-xl p-3 space-y-3">
              <p className="text-xs font-semibold text-gray-600">
                Rôle sur un dossier précis (optionnel)
              </p>
              <Select
                label="Dossier concerné"
                value={inviteDocumentMemberId}
                onChange={(e) => setInviteDocumentMemberId(e.target.value)}
              >
                <option value="">Aucun — rôle d'espace uniquement</option>
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
                  label="Rôle sur ce dossier *"
                  value={inviteDocumentRole}
                  onChange={(e) => setInviteDocumentRole(e.target.value)}
                >
                  <option value="">Choisir un rôle</option>
                  {DOCUMENT_ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          )}

          <p className="text-xs text-gray-400 bg-gray-50 rounded-xl px-3 py-2">
            💡 Un email d&apos;invitation est toujours envoyé, avec un lien sécurisé valide 30 jours — même si
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

      {/* Mini-modale : choix obligatoire de la fiche liée quand on passe
          quelqu'un au rôle "Dépendant" depuis la liste des comptes */}
      <Modal
        open={!!roleChangeTarget}
        onClose={() => setRoleChangeTarget(null)}
        title="Fiche correspondante"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Le rôle "Personne dépendante" nécessite de choisir à quelle fiche membre correspond ce compte.
          </p>
          <Select
            label="Fiche membre *"
            value={roleChangeLinkedMemberId}
            onChange={(e) => setRoleChangeLinkedMemberId(e.target.value)}
          >
            <option value="">Sélectionnez une fiche existante</option>
            {linkableFiches.map((m) => (
              <option key={m.id} value={m.id}>
                {m.firstName} {m.lastName}
              </option>
            ))}
          </Select>
          <div className="flex gap-3 pt-2">
            <Button variant="ghost" onClick={() => setRoleChangeTarget(null)} className="flex-1">
              Annuler
            </Button>
            <Button onClick={confirmRoleChangeToDependent} loading={updatingId === roleChangeTarget?.membershipId} className="flex-1">
              Valider
            </Button>
          </div>
        </div>
      </Modal>
    </AppShell>
  );
}