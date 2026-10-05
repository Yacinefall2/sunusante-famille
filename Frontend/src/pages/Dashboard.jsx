import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { MemberAvatar } from "../components/members/MemberAvatar";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import {
  Users,
  Calendar,
  Pill,
  Syringe,
  FileText,
  Plus,
  Clock,
  MapPin,
  Stethoscope,
  ChevronRight,
  Loader2,
  Heart,
  AlertTriangle,
} from "lucide-react";
import { formatDateTime, formatDate, APPOINTMENT_STATUSES } from "../lib/utils";
import { familyRoleBadgeVariant, noAccountSubtitle } from "../lib/roles";
import { kinshipLabel, memberSubtitle } from "../lib/kinship";
import { IntakeAnswerButtons, NOTIFICATIONS_REFRESH_EVENT } from "../components/notifications/intakes";
import { format, isToday, parseISO } from "date-fns";
import toast from "react-hot-toast";

export default function DashboardPage() {
  const { selectedFamily, families, loadFamilies, loading: familyLoading, isParent, isAdult, myMember, members, canWriteMember } =
    useFamily();
  // Seuls les Parents et Adultes peuvent créer une fiche (pas les Dépendants)
  const canCreateFiche = isParent || isAdult;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showNewFamily, setShowNewFamily] = useState(false);
  const [familyName, setFamilyName] = useState("");
  const [creating, setCreating] = useState(false);
  // Compteurs du foyer (membres, comptes) pour la carte "Membres".
  const [household, setHousehold] = useState(null);
  // Prises de médicaments récentes (pour la carte "Prises du jour").
  const [intakes, setIntakes] = useState([]);

  const loadIntakes = useCallback(async () => {
    if (!selectedFamily) return;
    try {
      const res = await fetch(`/api/intakes?familyId=${selectedFamily.id}&days=2`);
      const d = res.ok ? await res.json() : [];
      setIntakes(Array.isArray(d) ? d : []);
    } catch {
      setIntakes([]);
    }
  }, [selectedFamily]);

  // Rappels de vaccins en retard (statut calculé par le serveur).
  const [overdueBoosters, setOverdueBoosters] = useState([]);

  const loadOverdueBoosters = useCallback(async () => {
    if (!selectedFamily) return;
    try {
      const res = await fetch(`/api/vaccinations?familyId=${selectedFamily.id}`);
      const d = res.ok ? await res.json() : [];
      setOverdueBoosters(
        (Array.isArray(d) ? d : [])
          .filter((v) => v.boosterStatus === "en_retard")
          .sort((a, b) => (a.nextDoseDate < b.nextDoseDate ? -1 : 1))
      );
    } catch {
      setOverdueBoosters([]);
    }
  }, [selectedFamily]);

  useEffect(() => {
    loadOverdueBoosters();
    window.addEventListener(NOTIFICATIONS_REFRESH_EVENT, loadOverdueBoosters);
    return () => window.removeEventListener(NOTIFICATIONS_REFRESH_EVENT, loadOverdueBoosters);
  }, [loadOverdueBoosters]);

  // Chargement initial, puis rechargement après chaque réponse à une prise
  // (événement global émis par `respondIntake`).
  useEffect(() => {
    loadIntakes();
    window.addEventListener(NOTIFICATIONS_REFRESH_EVENT, loadIntakes);
    return () => window.removeEventListener(NOTIFICATIONS_REFRESH_EVENT, loadIntakes);
  }, [loadIntakes]);

  // Prises du jour encore en attente auxquelles l'utilisateur peut répondre :
  // titulaire de la fiche ou accès complet à la fiche.
  const memberById = (id) => members.find((m) => m.id === id);
  const pendingToday = intakes
    .filter((it) => it.status === "pending" && isToday(parseISO(it.scheduledAt)))
    .filter((it) => !!memberById(it.memberId)?.isMine || canWriteMember(it.memberId))
    .sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1));

  useEffect(() => {
    if (selectedFamily) {
      loadDashboard(selectedFamily.id);
    }
  }, [selectedFamily]);

  const loadDashboard = async (familyId) => {
    setLoading(true);
    try {
      const [res, householdRes] = await Promise.all([
        fetch(`/api/dashboard?familyId=${familyId}`),
        fetch(`/api/members/household?familyId=${familyId}`).catch(() => null),
      ]);
      const d = await res.json();
      setData(d);
      setHousehold(householdRes?.ok ? await householdRes.json() : null);
    } finally {
      setLoading(false);
    }
  };

  // Nombre de membres du foyer (toutes les fiches) et de comptes
  const membersCount = household?.membersCount ?? data?.membersCount ?? members.length;
  const accountsCount = household?.accountsCount ?? members.filter((m) => m.account).length;

  const createFamily = async () => {
    if (!familyName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/families", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: familyName }),
      });
      if (res.ok) {
        toast.success("Famille créée avec succès !");
        setShowNewFamily(false);
        setFamilyName("");
        await loadFamilies();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Échec de la création de la famille");
      }
    } finally {
      setCreating(false);
    }
  };

  const getStatusBadge = (status) => {
    const s = APPOINTMENT_STATUSES.find((a) => a.value === status);
    if (!s) return null;
    return <Badge variant={s.variant}>{s.label}</Badge>;
  };

  if (familyLoading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="animate-spin text-teal-600" size={40} />
        </div>
      </AppShell>
    );
  }

  // Pas encore de famille — écran de bienvenue
  // (note : ce cas ne peut pas survenir pour un Dépendant, puisqu'avoir ce
  // rôle implique déjà appartenir à au moins une famille)
  if (families.length === 0) {
    return (
      <AppShell>
        <div className="max-w-2xl mx-auto pt-8">
          <div className="bg-white rounded-3xl shadow-xl overflow-hidden">
            <div className="relative h-56 bg-gradient-to-br from-teal-500 to-blue-600">
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
                <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center mb-3 backdrop-blur-sm">
                  <Heart size={32} className="text-white" />
                </div>
                <h2 className="text-3xl font-bold">Bienvenue sur SunuSanté Famille</h2>
                <p className="text-teal-100 mt-1">Votre santé, notre priorité</p>
              </div>
            </div>
            <div className="p-8 text-center">
              <h3 className="text-xl font-bold text-gray-800 mb-2">Commencez par créer votre famille</h3>
              <p className="text-gray-500 mb-8 max-w-md mx-auto">
                Créez un espace familial pour centraliser les informations médicales de tous vos proches.
              </p>
              <div className="grid grid-cols-3 gap-4 mb-8 text-center">
                {[
                  { icon: Users, label: "Profils membres", color: "text-teal-600 bg-teal-50" },
                  { icon: Calendar, label: "Rendez-vous", color: "text-blue-600 bg-blue-50" },
                  { icon: FileText, label: "Documents", color: "text-purple-600 bg-purple-50" },
                ].map(({ icon: Icon, label, color }) => (
                  <div key={label} className="flex flex-col items-center gap-2">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${color}`}>
                      <Icon size={22} />
                    </div>
                    <p className="text-xs font-medium text-gray-600">{label}</p>
                  </div>
                ))}
              </div>
              <Button size="lg" onClick={() => setShowNewFamily(true)}>
                <Plus size={20} />
                Créer ma famille
              </Button>
            </div>
          </div>
        </div>

        <Modal open={showNewFamily} onClose={() => setShowNewFamily(false)} title="Créer une famille">
          <div className="space-y-4">
            <Input
              label="Nom de la famille"
              placeholder="Ex: Famille Dupont"
              value={familyName}
              onChange={(e) => setFamilyName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createFamily()}
            />
            <div className="flex gap-3 pt-2">
              <Button variant="ghost" onClick={() => setShowNewFamily(false)} className="flex-1">
                Annuler
              </Button>
              <Button onClick={createFamily} loading={creating} className="flex-1">
                Créer
              </Button>
            </div>
          </div>
        </Modal>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">
              {/* Pas de double préfixe si le nom commence déjà par « Famille » */}
              {/^\s*famille(\s|$)/i.test(selectedFamily?.name ?? "") ? selectedFamily?.name : `Famille ${selectedFamily?.name ?? ""}`}
            </h2>
            <p className="text-gray-500 text-sm mt-0.5">
              {membersCount} membre{membersCount > 1 ? "s" : ""} · {accountsCount} avec un compte
            </p>
          </div>
          {/* Le bouton "Nouvelle famille" est supprimé : une personne déjà
              membre d'une famille ne peut pas en créer une autre. */}
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            {
              label: "Membres",
              sublabel: `${accountsCount} avec un compte`,
              value: membersCount,
              icon: Users,
              color: "from-teal-500 to-teal-600",
              href: "/membres",
            },
            {
              label: "RDV à venir",
              value: data?.upcomingAppointments?.length ?? 0,
              icon: Calendar,
              color: "from-blue-500 to-blue-600",
              href: "/rendez-vous",
            },
            {
              label: "Traitements actifs",
              value: data?.activeTreatmentsCount ?? 0,
              icon: Pill,
              color: "from-violet-500 to-violet-600",
              href: "/traitements",
            },
            {
              label: "Vaccinations",
              value: data?.recentVaccinations?.length ?? 0,
              icon: Syringe,
              color: "from-amber-500 to-orange-500",
              href: "/vaccinations",
            },
          ].map((stat) => {
            const Icon = stat.icon;
            return (
              <Link key={stat.label} to={stat.href}>
                <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 hover:shadow-md transition-all duration-200 cursor-pointer group">
                  <div className="flex items-center justify-between mb-3">
                    <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${stat.color} flex items-center justify-center shadow-md`}>
                      <Icon size={18} className="text-white" />
                    </div>
                    <ChevronRight size={16} className="text-gray-300 group-hover:text-teal-500 transition-colors" />
                  </div>
                  <p className="text-3xl font-bold text-gray-800">{loading ? "—" : stat.value}</p>
                  <p className="text-sm text-gray-500 mt-1">{stat.label}</p>
                  {stat.sublabel && <p className="text-xs text-gray-400">{stat.sublabel}</p>}
                </div>
              </Link>
            );
          })}
        </div>

        {/* Prises du jour en attente de réponse (masquée s'il n'y en a aucune) */}
        {pendingToday.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-violet-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-800 flex items-center gap-2">
                <Pill size={18} className="text-violet-600" /> Prises du jour
              </h3>
              <Link to="/traitements" className="text-xs text-teal-600 hover:underline font-medium">
                Voir les traitements
              </Link>
            </div>
            <div className="space-y-2">
              {pendingToday.map((it) => {
                const member = memberById(it.memberId);
                return (
                  <div key={it.id} className="flex items-center justify-between gap-3 flex-wrap p-3 rounded-xl border border-gray-50 hover:bg-gray-50 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-violet-50 flex items-center justify-center flex-shrink-0">
                        <Clock size={18} className="text-violet-600" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-800 text-sm truncate">
                          {format(parseISO(it.scheduledAt), "HH:mm")} · {it.medicationName}
                          {it.dosage && <span className="font-normal text-gray-400"> ({it.dosage})</span>}
                        </p>
                        {member && (
                          <p className="text-xs text-gray-500 truncate">
                            {member.firstName} {member.lastName}
                          </p>
                        )}
                      </div>
                    </div>
                    <IntakeAnswerButtons intakeId={it.id} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Rappels de vaccins en retard (masquée s'il n'y en a aucun) */}
        {overdueBoosters.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-red-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-800 flex items-center gap-2">
                <AlertTriangle size={18} className="text-red-600" /> Rappels de vaccins en retard
                <Badge variant="danger" className="px-2 py-0.5">{overdueBoosters.length}</Badge>
              </h3>
              <Link to="/vaccinations" className="text-xs text-teal-600 hover:underline font-medium">
                Voir les vaccinations
              </Link>
            </div>
            <div className="space-y-2">
              {overdueBoosters.map((v) => {
                const member = memberById(v.memberId);
                return (
                  <Link
                    key={v.id}
                    to="/vaccinations"
                    className="flex items-center justify-between gap-3 p-3 rounded-xl border border-red-50 hover:bg-red-50/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
                        <Syringe size={18} className="text-red-600" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-800 text-sm truncate">{v.vaccineName}</p>
                        <p className="text-xs text-gray-500 truncate">
                          {member ? `${member.firstName} ${member.lastName} · ` : ""}
                          <span className="text-red-600">en retard depuis le {formatDate(v.nextDoseDate)}</span>
                        </p>
                      </div>
                    </div>
                    <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Members */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-800 flex items-center gap-2">
                <Users size={18} className="text-teal-600" /> Membres
              </h3>
              <Link to="/membres" className="text-xs text-teal-600 hover:underline font-medium">
                Voir tout
              </Link>
            </div>
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="animate-spin text-teal-500" size={24} />
              </div>
            ) : members.length > 0 ? (
              <div className="space-y-3">
                {members.slice(0, 6).map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors">
                    <div className="min-w-0">
                      <MemberAvatar member={m} size="md" showName />
                      <p className="text-xs text-gray-400 mt-0.5 pl-[52px] truncate">
                        {memberSubtitle(m)} · {m.account ? `Compte : ${m.account.name}` : noAccountSubtitle(m.status, m.dateOfBirth)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                      {m.relayPending && (
                        <Badge variant="warning" className="px-2 py-0.5 text-[11px]">
                          À relayer
                        </Badge>
                      )}
                      {/* Lien de parenté vu par l'utilisateur ("Vous", "Petit frère"...) */}
                      <Badge variant={myMember?.id === m.id ? "success" : "info"}>
                        {kinshipLabel(m, myMember, members)}
                      </Badge>
                      {m.account?.role === "parent" && (
                        <Badge variant={familyRoleBadgeVariant("parent", m.account.isPrimaryAdmin)}>
                          {m.account.isPrimaryAdmin ? "Administrateur" : "Co-administrateur"}
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
                {members.length > 6 && (
                  <Link to="/membres" className="block text-center text-xs text-teal-600 hover:underline font-medium">
                    + {members.length - 6} autre{members.length - 6 > 1 ? "s" : ""}
                  </Link>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400">
                <Users size={32} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">Aucun membre enregistré pour l&apos;instant</p>
                {canCreateFiche && (
                  <Link to="/membres">
                    <Button variant="outline" size="sm" className="mt-3">
                      <Plus size={14} />
                      Ajouter un membre
                    </Button>
                  </Link>
                )}
              </div>
            )}
          </div>

          {/* Upcoming appointments */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-800 flex items-center gap-2">
                <Calendar size={18} className="text-blue-600" /> Prochains rendez-vous
              </h3>
              <Link to="/rendez-vous" className="text-xs text-teal-600 hover:underline font-medium">
                Voir tout
              </Link>
            </div>
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="animate-spin text-teal-500" size={24} />
              </div>
            ) : data?.upcomingAppointments && data.upcomingAppointments.length > 0 ? (
              <div className="space-y-3">
                {data.upcomingAppointments.map((appt) => (
                  <div key={appt.id} className="flex gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors border border-gray-50">
                    <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
                      <Stethoscope size={18} className="text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-gray-800 text-sm truncate">{appt.title}</p>
                        {getStatusBadge(appt.status)}
                      </div>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        <span className="text-xs text-gray-500 flex items-center gap-1">
                          <Clock size={11} />
                          {formatDateTime(appt.appointmentDate)}
                        </span>
                        {appt.location && (
                          <span className="text-xs text-gray-400 flex items-center gap-1">
                            <MapPin size={11} />
                            {appt.location}
                          </span>
                        )}
                      </div>
                      <div className="mt-1">
                        {appt.member && <MemberAvatar member={appt.member} size="sm" showName />}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400">
                <Calendar size={32} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">Aucun rendez-vous à venir</p>
                <Link to="/rendez-vous">
                  <Button variant="outline" size="sm" className="mt-3">
                    <Plus size={14} />
                    Planifier un RDV
                  </Button>
                </Link>
              </div>
            )}
          </div>

          {/* Recent vaccinations */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-800 flex items-center gap-2">
                <Syringe size={18} className="text-amber-600" /> Vaccinations récentes
              </h3>
              <Link to="/vaccinations" className="text-xs text-teal-600 hover:underline font-medium">
                Voir tout
              </Link>
            </div>
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="animate-spin text-teal-500" size={24} />
              </div>
            ) : data?.recentVaccinations && data.recentVaccinations.length > 0 ? (
              <div className="space-y-3">
                {data.recentVaccinations.map((v) => (
                  <div key={v.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors">
                    <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center flex-shrink-0">
                      <Syringe size={18} className="text-amber-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-gray-800 text-sm">{v.vaccineName}</p>
                      <p className="text-xs text-gray-500">{formatDate(v.dateAdministered)}</p>
                    </div>
                    {v.member && <MemberAvatar member={v.member} size="sm" />}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400">
                <Syringe size={32} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">Aucune vaccination enregistrée</p>
              </div>
            )}
          </div>

          {/* Recent documents */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-800 flex items-center gap-2">
                <FileText size={18} className="text-violet-600" /> Documents récents
              </h3>
              <Link to="/documents" className="text-xs text-teal-600 hover:underline font-medium">
                Voir tout
              </Link>
            </div>
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="animate-spin text-teal-500" size={24} />
              </div>
            ) : data?.recentDocuments && data.recentDocuments.length > 0 ? (
              <div className="space-y-3">
                {data.recentDocuments.map((doc) => (
                  <div key={doc.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors">
                    <div className="w-10 h-10 rounded-xl bg-violet-50 flex items-center justify-center flex-shrink-0">
                      <FileText size={18} className="text-violet-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-gray-800 text-sm truncate">{doc.title}</p>
                      <p className="text-xs text-gray-500 capitalize">{doc.documentType}</p>
                    </div>
                    {doc.member && <MemberAvatar member={doc.member} size="sm" />}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400">
                <FileText size={32} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">Aucun document ajouté</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* New Family Modal */}
      <Modal open={showNewFamily} onClose={() => setShowNewFamily(false)} title="Créer une famille">
        <div className="space-y-4">
          <Input
            label="Nom de la famille"
            placeholder="Ex: Famille Martin"
            value={familyName}
            onChange={(e) => setFamilyName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createFamily()}
          />
          <div className="flex gap-3 pt-2">
            <Button variant="ghost" onClick={() => setShowNewFamily(false)} className="flex-1">
              Annuler
            </Button>
            <Button onClick={createFamily} loading={creating} className="flex-1">
              Créer
            </Button>
          </div>
        </div>
      </Modal>
    </AppShell>
  );
}