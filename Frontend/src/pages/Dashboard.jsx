import { useEffect, useState } from "react";
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
} from "lucide-react";
import { formatDateTime, formatDate, APPOINTMENT_STATUSES } from "../lib/utils";
import toast from "react-hot-toast";

export default function DashboardPage() {
  const { selectedFamily, families, loadFamilies, loading: familyLoading, isDependent } = useFamily();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showNewFamily, setShowNewFamily] = useState(false);
  const [familyName, setFamilyName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (selectedFamily) {
      loadDashboard(selectedFamily.id);
    }
  }, [selectedFamily]);

  const loadDashboard = async (familyId) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard?familyId=${familyId}`);
      const d = await res.json();
      setData(d);
    } finally {
      setLoading(false);
    }
  };

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
    const variant = status === "upcoming" ? "info" : status === "completed" ? "success" : "danger";
    return <Badge variant={variant}>{s.label}</Badge>;
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
                <h2 className="text-3xl font-bold">Bienvenue sur SantéFamille</h2>
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
            <h2 className="text-2xl font-bold text-gray-800">Famille {selectedFamily?.name}</h2>
            <p className="text-gray-500 text-sm mt-0.5">
              {data?.membersCount ?? 0} membre{(data?.membersCount ?? 0) > 1 ? "s" : ""}
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
              value: data?.membersCount ?? 0,
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
                </div>
              </Link>
            );
          })}
        </div>

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
            ) : data?.members && data.members.length > 0 ? (
              <div className="space-y-3">
                {data.members.slice(0, 5).map((m) => (
                  <div key={m.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors">
                    <MemberAvatar member={m} size="md" showName showAge />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400">
                <Users size={32} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">Aucun membre pour l&apos;instant</p>
                <Link to="/membres">
                  <Button variant="outline" size="sm" className="mt-3">
                    <Plus size={14} />
                    Ajouter un membre
                  </Button>
                </Link>
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
                        <MemberAvatar member={appt.member} size="sm" showName />
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
                    <MemberAvatar member={v.member} size="sm" />
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
                    <MemberAvatar member={doc.member} size="sm" />
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