import { useCallback, useEffect, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { MemberAvatar } from "../components/members/MemberAvatar";
import { MemberFormModal } from "../components/members/MemberFormModal";
import { Link } from "react-router-dom";
import { Plus, Loader2, Users, Info, ChevronDown, UserX, UserCircle, AlertCircle } from "lucide-react";
import {
  accountRoleLabel,
  familyRoleBadgeVariant,
  memberStatusLabel,
  myRelationSentence,
  noAccountSubtitle,
} from "../lib/roles";
import { kinshipIncomplete, kinshipLabel, memberSubtitle } from "../lib/kinship";

const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

// Page "Membres de la famille" : toutes les personnes du foyer, avec ou sans
// compte, visibles par tous. Aucune donnée médicale ici — les dossiers sont
// sur la page "Fiches médicales".
export default function MembresPage() {
  const {
    selectedFamily,
    isParent,
    isAdult,
    isPrimaryAdmin,
    myRole,
    members,
    myMember,
    canWriteMember,
    membersLoading: loading,
  } = useFamily();
  const [household, setHousehold] = useState(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showForm, setShowForm] = useState(false);

  // Seuls les administrateurs et les adultes peuvent ajouter un membre
  const canCreate = isParent || isAdult;

  // Compteurs du foyer : membres, comptes, comptes sans fiche
  const loadHousehold = useCallback(async () => {
    if (!selectedFamily) return;
    try {
      const res = await fetch(`/api/members/household?familyId=${selectedFamily.id}`);
      setHousehold(res.ok ? await res.json() : null);
    } catch {
      setHousehold(null);
    }
  }, [selectedFamily]);

  // Rechargé aussi quand la liste des membres change (ajout, suppression...)
  useEffect(() => {
    loadHousehold();
  }, [loadHousehold, members]);

  const membersCount = household?.membersCount ?? members.length;
  const accountsCount = household?.accountsCount ?? members.filter((m) => m.account).length;
  const withoutFiche = household?.accountsWithoutFiche ?? [];

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
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-800">Membres de la famille — {selectedFamily.name}</h2>
            <p className="text-sm text-gray-500">
              {plural(membersCount, "membre")} · {accountsCount} avec un compte
              {withoutFiche.length > 0 && ` · ${plural(withoutFiche.length, "compte")} sans fiche`}
            </p>
          </div>
          {canCreate && (
            <div className="flex flex-col items-start sm:items-end gap-1">
              <Button onClick={() => setShowForm(true)}>
                <Plus size={16} />
                Ajouter un membre
              </Button>
              <p className="text-xs text-gray-400 max-w-xs sm:text-right">
                Ajoute une personne du foyer (avec ou sans compte) et crée sa fiche médicale.
              </p>
            </div>
          )}
        </div>

        {/* Encadré d'explication des trois notions */}
        <div className="bg-blue-50 border border-blue-100 rounded-2xl">
          <button
            type="button"
            onClick={() => setShowInfo((v) => !v)}
            className="w-full flex items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-blue-800"
          >
            <span className="flex items-center gap-2">
              <Info size={16} />
              Membre, compte, fiche : quelle différence ?
            </span>
            <ChevronDown size={16} className={`transition-transform ${showInfo ? "rotate-180" : ""}`} />
          </button>
          {showInfo && (
            <ul className="px-4 pb-4 space-y-1.5 text-sm text-blue-900">
              <li>
                <strong>Membre</strong> : une personne du foyer, avec ou sans compte (un enfant, un grand-parent au
                village sans smartphone…).
              </li>
              <li>
                <strong>Compte</strong> : un accès à l'application (email + mot de passe), avec un rôle dans la
                famille.
              </li>
              <li>
                <strong>Fiche</strong> : le dossier médical d'un membre — une fiche par membre. Les rôles Gestionnaire,
                Relais et Lecteur invité se donnent sur une fiche.
              </li>
            </ul>
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
            <p className="text-gray-400 mb-6">Ajoutez les personnes de votre foyer pour commencer le suivi médical.</p>
            {canCreate && (
              <Button onClick={() => setShowForm(true)}>
                <Plus size={16} />
                Ajouter un membre
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {members.map((m) => {
              return (
                <div key={m.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <MemberAvatar member={m} size="lg" showName />
                      <p className="text-xs text-gray-500 mt-1 pl-[68px]">{memberSubtitle(m)}</p>
                    </div>
                    {m.relayPending && (
                      <Badge variant="warning" className="px-2 py-0.5 text-[11px] flex-shrink-0">
                        À relayer
                      </Badge>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {/* Lien de parenté vu par l'utilisateur courant ("Petit frère", "Grand-mère", "Vous"...) */}
                    <Badge variant={m.isMine ? "success" : "info"}>{kinshipLabel(m, myMember, members)}</Badge>
                    {m.account?.role === "parent" && (
                      <Badge variant={familyRoleBadgeVariant("parent", m.account.isPrimaryAdmin)}>
                        {m.account.isPrimaryAdmin ? "Administrateur" : "Co-administrateur"}
                      </Badge>
                    )}
                  </div>

                  {kinshipIncomplete(m) &&
                    (canWriteMember(m.id) ? (
                      // Tout l'encadré ouvre directement le formulaire de modification.
                      <Link
                        to={`/fiches?fiche=${m.id}&modifier=1`}
                        className="flex items-center gap-1.5 text-xs text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-xl px-3 py-2 transition-colors"
                      >
                        <AlertCircle size={13} className="flex-shrink-0" />
                        <span className="flex-1">À compléter : lien, âge ou sexe</span>
                        <span className="font-semibold underline">Compléter</span>
                      </Link>
                    ) : (
                      <p className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 rounded-xl px-3 py-2">
                        <AlertCircle size={13} className="flex-shrink-0" />
                        <span>
                          Fiche à compléter (lien, âge ou sexe) — par{" "}
                          {m.hasAccount ? "son titulaire ou " : "son gestionnaire ou "}un administrateur.
                        </span>
                      </p>
                    ))}

                  <div className="space-y-1 text-xs">
                    <p className="flex items-center gap-1.5 text-gray-600">
                      <UserCircle size={13} className="text-gray-400 flex-shrink-0" />
                      {m.account ? `Compte : ${m.account.name}` : noAccountSubtitle(m.status, m.dateOfBirth)}
                    </p>
                    {/* Niveau d'accès déduit de l'âge par le serveur */}
                    {m.account?.role === "dependent" && (
                      <p className="text-gray-500 pl-[19px]">Compte adolescent (lecture seule jusqu&apos;à 18 ans)</p>
                    )}
                    {/* Sans compte, la ligne du dessus décrit déjà le statut : pas de doublon. */}
                    {(m.account || memberStatusLabel(m.status) !== noAccountSubtitle(m.status, m.dateOfBirth)) && (
                      <p className="text-gray-400">Statut : {memberStatusLabel(m.status)}</p>
                    )}
                  </div>

                  <p className="text-xs text-teal-700 bg-teal-50 rounded-xl px-3 py-2">
                    {myRelationSentence(m, { myRole, isPrimaryAdmin })}
                  </p>

                </div>
              );
            })}
          </div>
        )}

        {/* Comptes qui n'ont pas encore créé leur fiche */}
        {withoutFiche.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
              <UserX size={16} className="text-amber-600" />
              <h3 className="font-bold text-gray-800 text-sm">Comptes sans fiche</h3>
            </div>
            <div className="divide-y divide-gray-50">
              {withoutFiche.map((a) => (
                <div key={a.userId} className="px-6 py-4 flex items-center gap-4 flex-wrap">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-teal-400 to-blue-500 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                    {a.name?.[0]?.toUpperCase() ?? "?"}
                  </div>
                  <div className="flex-1 min-w-[160px]">
                    <p className="font-semibold text-gray-800 text-sm">{a.name}</p>
                    <p className="text-xs text-gray-400 italic">N'a pas encore créé sa fiche</p>
                  </div>
                  <Badge variant={familyRoleBadgeVariant(a.role, a.isPrimaryAdmin)}>{accountRoleLabel(a)}</Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <MemberFormModal open={showForm} onClose={() => setShowForm(false)} />
    </AppShell>
  );
}
