import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useFamily } from "../context/FamilyContext";
import { Button } from "../components/ui/Button";
import { Input, Textarea, Select } from "../components/ui/Input";
import { MemberAvatar } from "../components/members/MemberAvatar";
import { CONTACT_FIELDS_DEFAULTS, MemberContactFields } from "../components/members/MemberContactFields";
import { IDENTITY_FIELDS_DEFAULTS, IdentityFields, identityError, identityPayload } from "../components/members/IdentityFields";
import { UserCheck, UserPlus, LogOut, ChevronDown, AlertTriangle } from "lucide-react";
import { AVATAR_COLORS, BLOOD_TYPES } from "../lib/utils";
import toast from "react-hot-toast";

const defaultForm = {
  firstName: "",
  lastName: "",
  ...IDENTITY_FIELDS_DEFAULTS,
  bloodType: "",
  allergies: "",
  ...CONTACT_FIELDS_DEFAULTS,
};

// Écran "Ma fiche" — bloquant tant que le compte n'est relié à aucune fiche
// dans la famille sélectionnée. Chaque membre de l'espace est titulaire de sa
// propre fiche médicale : on la désigne parmi celles qu'on gère déjà (créées
// par soi avant d'avoir un compte, par exemple) ou on la crée.
export default function MaFichePage() {
  const { user, logout } = useAuth();
  const { selectedFamily, members, reloadMembers, reloadMembership, isParent } = useFamily();
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  const [claimingId, setClaimingId] = useState(null);
  // Section repliable "Informations complémentaires" (contacts, médecin...).
  const [showMore, setShowMore] = useState(false);
  // Message d'erreur du serveur affiché en clair (ex. moins de 15 ans :
  // pas de compte personnel, la fiche est tenue par les parents).
  const [serverError, setServerError] = useState("");
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  // Fiches que l'on peut désigner comme sienne : on en est Gestionnaire et
  // aucun compte n'y est encore relié.
  const claimable = members.filter((m) => m.myDocumentRole === "gestionnaire" && !m.hasAccount);

  const f = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  // Après succès : on recharge l'appartenance (fiche liée) puis les fiches,
  // ce qui lève l'écran et donne accès à l'application.
  const done = async () => {
    await reloadMembers();
    await reloadMembership();
  };

  const claim = async (id) => {
    setClaimingId(id);
    setServerError("");
    try {
      const res = await fetch("/api/members/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        toast.success("C'est noté, cette fiche est désormais la vôtre !");
        await done();
      } else {
        const err = await res.json().catch(() => ({}));
        setServerError(err.error || "");
        toast.error(err.error || "Impossible de désigner cette fiche");
      }
    } finally {
      setClaimingId(null);
    }
  };

  const create = async () => {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      toast.error("Prénom et nom sont requis");
      return;
    }
    // Un administrateur (parent) n'indique pas de lien : le serveur fixe "parent"
    const identityMsg = identityError(form, { isAdmin: isParent });
    if (identityMsg) {
      toast.error(identityMsg);
      return;
    }
    const { kinship: _k, kinshipRelatedMemberId: _r, ...rest } = form;
    setServerError("");
    setSaving(true);
    try {
      const res = await fetch("/api/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          familyId: selectedFamily.id,
          ...rest,
          ...identityPayload(form, { isAdmin: isParent }),
          notes: "",
          avatarColor: AVATAR_COLORS[members.length % AVATAR_COLORS.length],
          status: "connecte_autonome",
          isMine: true,
        }),
      });
      if (res.ok) {
        toast.success("Votre fiche a été créée !");
        await done();
      } else {
        const err = await res.json().catch(() => ({}));
        setServerError(err.error || "");
        toast.error(err.error || "Erreur lors de la création de votre fiche");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-xl p-8">
        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-teal-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <UserCheck size={28} className="text-teal-600" />
          </div>
          <h1 className="text-xl font-bold text-gray-800 mb-2">Votre fiche médicale</h1>
          <p className="text-sm text-gray-500">
            Bienvenue{user?.name ? `, ${user.name}` : ""} ! Chaque membre de l'espace
            {selectedFamily ? ` « ${selectedFamily.name} »` : ""} a sa propre fiche médicale, dont il est
            titulaire : c'est vous qui décidez avec qui la partager. Avant de continuer, indiquez quelle est la vôtre.
          </p>
        </div>

        {serverError && (
          <div className="mb-6 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
            <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
            <p>{serverError}</p>
          </div>
        )}

        {/* Option 1 — désigner une fiche existante que l'on gère déjà */}
        {claimable.length > 0 && (
          <div className="mb-6">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Votre fiche existe déjà ?</h2>
            <div className="space-y-2">
              {claimable.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-3 bg-gray-50 rounded-xl p-3">
                  <MemberAvatar member={m} size="md" showName showAge />
                  <Button size="sm" variant="outline" onClick={() => claim(m.id)} loading={claimingId === m.id} disabled={claimingId !== null}>
                    C'est ma fiche
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 my-6">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-xs text-gray-400 font-medium">ou</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>
          </div>
        )}

        {/* Option 2 — créer sa fiche */}
        <div className="space-y-4">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Créer ma fiche</h2>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Prénom *" placeholder="Marie" value={form.firstName} onChange={f("firstName")} />
            <Input label="Nom *" placeholder="Dupont" value={form.lastName} onChange={f("lastName")} />
          </div>
          <IdentityFields
            form={form}
            onChange={(key, value) => setForm((p) => ({ ...p, [key]: value }))}
            members={members}
            isAdmin={isParent}
          />
          <Select label="Groupe sanguin" value={form.bloodType} onChange={f("bloodType")}>
            <option value="">Non connu</option>
            {BLOOD_TYPES.map((bt) => (
              <option key={bt} value={bt}>
                {bt}
              </option>
            ))}
          </Select>
          <Textarea label="Allergies connues" placeholder="Pénicilline, arachides..." value={form.allergies} onChange={f("allergies")} />
          <div className="border border-gray-200 rounded-xl">
            <button
              type="button"
              onClick={() => setShowMore((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 rounded-xl"
              aria-expanded={showMore}
            >
              <span>
                Informations complémentaires <span className="font-normal text-gray-400">(facultatif)</span>
              </span>
              <ChevronDown size={16} className={`text-gray-400 transition-transform ${showMore ? "rotate-180" : ""}`} />
            </button>
            {showMore && (
              <div className="px-4 pb-4 pt-1">
                <MemberContactFields form={form} onChange={(key, value) => setForm((p) => ({ ...p, [key]: value }))} />
              </div>
            )}
          </div>
          <Button onClick={create} loading={saving} className="w-full">
            <UserPlus size={16} />
            Créer ma fiche
          </Button>
        </div>

        <p className="text-sm text-gray-500 mt-6 text-center">
          <button onClick={handleLogout} className="inline-flex items-center gap-1.5 text-gray-500 hover:text-red-500 font-medium">
            <LogOut size={14} />
            Se déconnecter
          </button>
        </p>
      </div>
    </div>
  );
}
