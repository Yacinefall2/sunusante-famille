import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input, Textarea, Select } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { MemberAvatar } from "../components/members/MemberAvatar";
import { Plus, Pencil, Trash2, Loader2, Pill, User, Calendar, Stethoscope, X, Clock, History, Search } from "lucide-react";
import { formatDate } from "../lib/utils";
import { IntakeAnswerButtons, IntakeStatusBadge, NOTIFICATIONS_REFRESH_EVENT } from "../components/notifications/intakes";
import { format, isToday, parseISO, startOfDay, subDays } from "date-fns";
import { fr } from "date-fns/locale";
import toast from "react-hot-toast";

const emptyMedication = { name: "", dosage: "", frequency: "", duration: "", intakeTimes: [] };

// Raccourcis d'heures de prise les plus courants.
const INTAKE_PRESETS = [
  { label: "Matin", time: "08:00" },
  { label: "Midi", time: "13:00" },
  { label: "Soir", time: "20:00" },
  { label: "Coucher", time: "22:00" },
];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Normalise une liste d'heures "HH:MM" : valides, sans doublon, triées.
function normalizeTimes(times) {
  return [...new Set((times ?? []).filter((t) => TIME_RE.test(t)))].sort();
}

function formatIntakeTimes(times) {
  return normalizeTimes(times).join(" · ");
}

// Éditeur des heures de prise d'un médicament : raccourcis à basculer,
// heure personnalisée, et puces supprimables.
function IntakeTimesEditor({ value, onChange }) {
  const [custom, setCustom] = useState("");
  const times = normalizeTimes(value);

  const toggle = (time) => {
    onChange(times.includes(time) ? times.filter((t) => t !== time) : normalizeTimes([...times, time]));
  };

  const addCustom = () => {
    if (!TIME_RE.test(custom)) {
      toast.error("Heure invalide");
      return;
    }
    onChange(normalizeTimes([...times, custom]));
    setCustom("");
  };

  // Une heure saisie est ajoutée dès qu'on quitte le champ (y compris en
  // cliquant directement sur « Enregistrer ») : sinon elle serait perdue en
  // silence et aucun rappel ne partirait.
  const commitTyped = () => {
    if (TIME_RE.test(custom)) {
      onChange(normalizeTimes([...times, custom]));
      setCustom("");
    }
  };

  return (
    <div className="mt-3">
      <label className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
        <Clock size={13} className="text-violet-500" /> Heures de prise
      </label>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {INTAKE_PRESETS.map((p) => {
          const on = times.includes(p.time);
          return (
            <button
              key={p.time}
              type="button"
              onClick={() => toggle(p.time)}
              className={`text-xs font-medium px-3 py-1 rounded-full border transition-colors ${
                on ? "bg-violet-600 text-white border-violet-600" : "bg-white text-gray-600 border-gray-200 hover:border-violet-300"
              }`}
            >
              {p.label} {p.time}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 mt-2">
        <input
          type="time"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={commitTyped}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
          className="px-3 py-1.5 rounded-xl border border-gray-200 bg-white text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
        <Button type="button" variant="ghost" size="sm" onClick={addCustom} disabled={!custom}>
          <Plus size={14} />
          Ajouter
        </Button>
      </div>
      {times.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {times.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-violet-50 text-violet-700 font-semibold">
              {t}
              <button
                type="button"
                onClick={() => onChange(times.filter((x) => x !== t))}
                className="hover:text-red-500"
                title="Retirer cette heure"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-amber-600 mt-2">
          Aucune heure de prise : aucun rappel ne sera envoyé pour ce médicament.
        </p>
      )}
    </div>
  );
}

// Affichage court du statut d'une prise sur la carte d'un traitement.
const INTAKE_CHIPS = {
  taken: { text: "✓", className: "bg-emerald-50 text-emerald-700", title: "Pris" },
  not_taken: { text: "✗", className: "bg-red-50 text-red-700", title: "Pas pris" },
  missed: { text: "sans réponse", className: "bg-gray-100 text-gray-500", title: "Sans réponse" },
  pending: { text: "en attente", className: "bg-amber-50 text-amber-700", title: "En attente" },
};

const intakeTime = (intake) => format(parseISO(intake.scheduledAt), "HH:mm");

// Prises du jour d'un traitement, classées par heure croissante.
function TodayIntakes({ intakes, canAnswer }) {
  if (intakes.length === 0) return null;
  return (
    <div className="mb-3 bg-gray-50 rounded-xl px-3 py-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
      <p className="text-xs font-semibold text-gray-500 flex items-center gap-1">
        <Clock size={11} className="text-violet-500" /> Prises du jour
      </p>
      {intakes.map((it) => {
        const chip = INTAKE_CHIPS[it.status] ?? INTAKE_CHIPS.pending;
        const answerable = it.status === "pending" && canAnswer(it.memberId);
        return (
          <div key={it.id} className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs text-gray-700 min-w-0 truncate">
              {it.medicationName}
              {it.dosage && <span className="text-gray-400"> ({it.dosage})</span>}
            </span>
            <div className="flex items-center gap-1.5">
              <span title={chip.title} className={`text-xs font-semibold px-2 py-0.5 rounded-full ${chip.className}`}>
                {intakeTime(it)} {chip.text}
              </span>
              {answerable && <IntakeAnswerButtons intakeId={it.id} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Historique des prises d'un traitement, regroupé par jour puis par heure.
function IntakeHistory({ intakes, canAnswer }) {
  const byDay = useMemo(() => {
    const groups = new Map();
    for (const it of intakes) {
      const key = format(parseISO(it.scheduledAt), "yyyy-MM-dd");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([day, list]) => [day, list.sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1))]);
  }, [intakes]);

  if (byDay.length === 0) {
    return <p className="text-sm text-gray-400 italic">Aucune prise enregistrée sur cette période.</p>;
  }

  return (
    <div className="space-y-3">
      {byDay.map(([day, list]) => (
        <div key={day} className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="bg-gray-50 px-3 py-1.5 text-xs font-bold text-gray-600 capitalize">
            {format(parseISO(day), "EEEE d MMMM yyyy", { locale: fr })}
          </div>
          {list.map((it, i) => (
            <div key={it.id} className={`flex items-center justify-between gap-2 flex-wrap px-3 py-2 text-sm ${i > 0 ? "border-t border-gray-100" : ""}`}>
              <span className="text-gray-700 min-w-0">
                <span className="font-semibold">{intakeTime(it)}</span> · {it.medicationName}
                {it.dosage && <span className="text-gray-400"> ({it.dosage})</span>}
              </span>
              <div className="flex items-center gap-2">
                <IntakeStatusBadge status={it.status} />
                {it.status === "pending" && canAnswer(it.memberId) && <IntakeAnswerButtons intakeId={it.id} />}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// Fenêtres d'affichage : historique détaillé (14 j) et taux de suivi (30 j).
const HISTORY_DAYS = 14;
const ADHERENCE_DAYS = 30;

// Début de la fenêtre des `days` derniers jours (aujourd'hui inclus).
const windowStart = (days) => startOfDay(subDays(new Date(), days - 1));

// Prises d'un médicament : par identifiant, à défaut par nom.
const intakesOfMedication = (intakes, med) =>
  intakes.filter((it) => (med.id != null ? it.medicationId === med.id : it.medicationName === med.name));

// Taux de suivi (observance) sur les 30 derniers jours : les prises en
// attente sont ignorées ; « pas prise » et « sans réponse » comptent comme
// non suivies.
function computeAdherence(intakes) {
  const since = windowStart(ADHERENCE_DAYS);
  let taken = 0;
  let notTaken = 0;
  let missed = 0;
  for (const it of intakes) {
    if (parseISO(it.scheduledAt) < since) continue;
    if (it.status === "taken") taken++;
    else if (it.status === "not_taken") notTaken++;
    else if (it.status === "missed") missed++;
  }
  const total = taken + notTaken + missed;
  return { taken, notTaken, missed, total, pct: total > 0 ? Math.round((taken / total) * 100) : null };
}

// Couleur selon le taux : ≥ 80 % vert, 50–79 % orange, < 50 % rouge.
function adherenceTone(pct) {
  if (pct >= 80) return { dot: "bg-emerald-500", bar: "bg-emerald-500", text: "text-emerald-700" };
  if (pct >= 50) return { dot: "bg-amber-500", bar: "bg-amber-500", text: "text-amber-700" };
  return { dot: "bg-red-500", bar: "bg-red-500", text: "text-red-700" };
}

function adherenceText(a) {
  return `${a.taken} prise${a.taken > 1 ? "s" : ""} sur ${a.total} — ${a.pct} %`;
}

// Taux de suivi en version compacte (carte du traitement).
function AdherenceCompact({ name, adherence }) {
  if (adherence.pct === null) {
    return (
      <p className="text-xs text-gray-400 flex items-center gap-1.5 min-w-0">
        <span className="w-2 h-2 rounded-full bg-gray-300 flex-shrink-0" />
        <span className="truncate">
          {name && <span className="font-medium text-gray-500">{name} : </span>}
          Pas encore de prise suivie
        </span>
      </p>
    );
  }
  const tone = adherenceTone(adherence.pct);
  return (
    <p className="text-xs text-gray-600 flex items-center gap-1.5 min-w-0" title="Taux de suivi sur 30 jours">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${tone.dot}`} />
      <span className="truncate">
        {name && <span className="font-medium text-gray-700">{name} : </span>}
        <span className={tone.text}>{adherenceText(adherence)}</span>
      </span>
    </p>
  );
}

// Taux de suivi détaillé avec barre de progression (fenêtre de détail).
function AdherenceBar({ adherence }) {
  if (adherence.pct === null) {
    return <p className="text-xs text-gray-400 italic">Pas encore de prise suivie</p>;
  }
  const tone = adherenceTone(adherence.pct);
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={`font-semibold ${tone.text}`}>{adherenceText(adherence)}</span>
        <span className="text-gray-400">
          {adherence.notTaken} pas prise{adherence.notTaken > 1 ? "s" : ""} · {adherence.missed} sans réponse
        </span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden mt-1">
        <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${adherence.pct}%` }} />
      </div>
    </div>
  );
}

// Statut affiché d'un traitement : le serveur le désactive automatiquement
// le lendemain de sa date de fin.
function treatmentStatus(t, activeLabel = "Actif") {
  if (t.isActive) return { label: activeLabel, variant: "success" };
  if (t.endDate && parseISO(t.endDate) < startOfDay(new Date())) {
    return { label: `Terminé le ${formatDate(t.endDate)}`, variant: "default" };
  }
  return { label: "Terminé", variant: "default" };
}

// Clé de regroupement d'une maladie : « Paludisme », « paludisme » et
// « Paludisme » (espaces en trop) désignent la même maladie.
const diseaseKey = (disease) =>
  (disease ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

// Au-delà de ce nombre de maladies, un champ de recherche filtre la liste.
const DISEASE_SEARCH_THRESHOLD = 8;

const defaultForm = {
  memberId: "",
  disease: "",
  startDate: "",
  endDate: "",
  prescribedBy: "",
  isActive: true,
  notes: "",
  medications: [{ ...emptyMedication }],
};

export default function TraitementsPage() {
  // Fiches de la famille issues du contexte, avec le niveau d'accès de
  // l'utilisateur : saisie / modification / suppression uniquement sur les
  // fiches en accès complet.
  const { selectedFamily, members, writableMembers, canWriteMember, canReadMember } = useFamily();
  const [treatments, setTreatments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  const [filterActive, setFilterActive] = useState("all");
  const [viewing, setViewing] = useState(null);
  // Recherche en deux temps, comme pour les documents : on choisit d'abord un
  // membre (tous ses traitements) ou une maladie (les membres traités pour
  // elle), avant d'afficher la liste.
  // null | { by: "member", value: "<id>" | "all" } | { by: "disease", value: "<clé>" }
  const [selection, setSelection] = useState(null);
  const [diseaseQuery, setDiseaseQuery] = useState("");
  // Prises de médicaments des 30 derniers jours (fiches lisibles) : taux de
  // suivi sur 30 jours, historique détaillé sur les 14 derniers.
  const [intakes, setIntakes] = useState([]);

  const loadIntakes = useCallback(async () => {
    if (!selectedFamily) return;
    try {
      const res = await fetch(`/api/intakes?familyId=${selectedFamily.id}&days=${ADHERENCE_DAYS}`);
      const data = res.ok ? await res.json() : [];
      setIntakes(Array.isArray(data) ? data : []);
    } catch {
      setIntakes([]);
    }
  }, [selectedFamily]);

  useEffect(() => {
    if (selectedFamily) {
      load();
      loadIntakes();
    }
    setSelection(null);
    setDiseaseQuery("");
  }, [selectedFamily, loadIntakes]);

  // Rechargement des prises après une réponse (ici, sur le tableau de bord
  // ou depuis la cloche) : `respondIntake` émet cet événement global.
  useEffect(() => {
    window.addEventListener(NOTIFICATIONS_REFRESH_EVENT, loadIntakes);
    return () => window.removeEventListener(NOTIFICATIONS_REFRESH_EVENT, loadIntakes);
  }, [loadIntakes]);

  // Peut répondre à une prise : titulaire de la fiche (adolescent, dépendant
  // inclus) ou personne ayant l'accès complet à la fiche.
  const canAnswer = (memberId) => !!members.find((m) => m.id === memberId)?.isMine || canWriteMember(memberId);

  const intakesOf = (treatmentId) => intakes.filter((it) => it.treatmentId === treatmentId);
  const recentIntakesOf = (treatmentId) => {
    const since = windowStart(HISTORY_DAYS);
    return intakesOf(treatmentId).filter((it) => parseISO(it.scheduledAt) >= since);
  };
  // Médicaments suivis (au moins une heure de prise) avec leur taux de suivi.
  const adherenceOf = (t) =>
    (t.medications ?? [])
      .filter((m) => normalizeTimes(m.intakeTimes).length > 0)
      .map((m) => ({ med: m, adherence: computeAdherence(intakesOfMedication(intakesOf(t.id), m)) }));
  const todayIntakesOf = (treatmentId) =>
    intakesOf(treatmentId)
      .filter((it) => isToday(parseISO(it.scheduledAt)))
      .sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1));

  const load = async () => {
    if (!selectedFamily) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/treatments?familyId=${selectedFamily.id}`);
      const data = await res.json().catch(() => null);
      setTreatments(res.ok && Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  };

  const openAdd = () => {
    setEditing(null);
    // Membre (ou maladie) présélectionné selon la recherche en cours.
    const selectedMemberId =
      selection?.by === "member" && selection.value !== "all" && canWriteMember(Number(selection.value))
        ? selection.value
        : null;
    setForm({
      ...defaultForm,
      memberId: selectedMemberId ?? writableMembers[0]?.id?.toString() ?? "",
      disease: selection?.by === "disease" ? diseases.find((d) => d.key === selection.value)?.label ?? "" : "",
      medications: [{ ...emptyMedication }],
    });
    setShowForm(true);
  };

  const openEdit = (t) => {
    setEditing(t);
    setForm({
      memberId: t.memberId.toString(),
      disease: t.disease,
      startDate: t.startDate ?? "",
      endDate: t.endDate ?? "",
      prescribedBy: t.prescribedBy ?? "",
      isActive: t.isActive,
      notes: t.notes ?? "",
      medications:
        t.medications && t.medications.length > 0
          ? t.medications.map((m) => ({
              name: m.name,
              dosage: m.dosage ?? "",
              frequency: m.frequency ?? "",
              duration: m.duration ?? "",
              intakeTimes: normalizeTimes(m.intakeTimes),
            }))
          : [{ ...emptyMedication }],
    });
    setViewing(null);
    setShowForm(true);
  };

  const addMedicationRow = () => {
    setForm((p) => ({ ...p, medications: [...p.medications, { ...emptyMedication }] }));
  };

  const removeMedicationRow = (index) => {
    setForm((p) => ({ ...p, medications: p.medications.filter((_, i) => i !== index) }));
  };

  const updateMedication = (index, key, value) => {
    setForm((p) => ({
      ...p,
      medications: p.medications.map((m, i) => (i === index ? { ...m, [key]: value } : m)),
    }));
  };

  const save = async () => {
    const validMedications = form.medications.filter((m) => m.name.trim());
    if (!form.memberId || !form.disease.trim()) {
      toast.error("Champs requis manquants");
      return;
    }
    if (validMedications.length === 0) {
      toast.error("Ajoutez au moins un médicament");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        medications: validMedications.map((m) => ({ ...m, intakeTimes: normalizeTimes(m.intakeTimes) })),
      };
      if (editing) {
        const res = await fetch("/api/treatments", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editing.id, ...payload }),
        });
        if (res.ok) {
          toast.success("Traitement modifié !");
          setShowForm(false);
          load();
        } else {
          const err = await res.json().catch(() => ({}));
          toast.error(err.error || "Erreur lors de la modification");
        }
      } else {
        const res = await fetch("/api/treatments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          toast.success("Traitement ajouté !");
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
  const removeTreatment = async (id) => {
    if (!confirm("Supprimer ce traitement ?")) return false;
    const res = await fetch(`/api/treatments?id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Erreur lors de la suppression");
      return false;
    }
    toast.success("Supprimé");
    load();
    return true;
  };

  const deleteTreatment = async (id) => {
    if (await removeTreatment(id)) setViewing(null);
  };

  const deleteTreatmentFromCard = (id) => removeTreatment(id);

  const f = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.value }));

  const getMember = (id) => members.find((m) => m.id === id);

  // Fiches consultables (celles dont l'API renvoie les traitements).
  const readableMembers = members.filter((m) => canReadMember(m.id));

  // Maladies distinctes de la famille, avec les membres traités pour chacune.
  // Libellé affiché : l'orthographe la plus fréquente.
  const diseases = useMemo(() => {
    const groups = new Map();
    for (const t of treatments) {
      const key = diseaseKey(t.disease);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { key, spellings: new Map(), memberIds: new Set(), activeCount: 0 });
      const g = groups.get(key);
      const spelling = t.disease.trim().replace(/\s+/g, " ");
      g.spellings.set(spelling, (g.spellings.get(spelling) ?? 0) + 1);
      g.memberIds.add(t.memberId);
      if (t.isActive) g.activeCount++;
    }
    return [...groups.values()]
      .map((g) => ({
        key: g.key,
        label: [...g.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0],
        memberIds: [...g.memberIds],
        activeCount: g.activeCount,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "fr"));
  }, [treatments]);

  const shownDiseases = diseaseQuery.trim()
    ? diseases.filter((d) => d.key.includes(diseaseKey(diseaseQuery)))
    : diseases;

  const treatmentCountOf = (memberId) => treatments.filter((t) => t.memberId === memberId).length;

  const selectedDisease = selection?.by === "disease" ? diseases.find((d) => d.key === selection.value) : null;

  const selectionLabel =
    selection?.by === "member"
      ? selection.value === "all"
        ? "Tous les membres"
        : getMember(Number(selection.value))?.firstName ?? ""
      : selectedDisease?.label ?? "";

  const resetSelection = () => {
    setSelection(null);
    setDiseaseQuery("");
  };

  const filtered = treatments.filter((t) => {
    if (selection?.by === "member" && selection.value !== "all" && t.memberId.toString() !== selection.value) return false;
    if (selection?.by === "disease" && diseaseKey(t.disease) !== selection.value) return false;
    if (filterActive === "active") return t.isActive;
    if (filterActive === "inactive") return !t.isActive;
    return true;
  });

  if (!selectedFamily) {
    return (
      <AppShell>
        <div className="text-center py-20 text-gray-400">
          <Pill size={48} className="mx-auto mb-3 opacity-30" />
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
            <h2 className="text-xl font-bold text-gray-800">Traitements — {selectedFamily.name}</h2>
            <p className="text-sm text-gray-500">
              {treatments.filter((t) => t.isActive).length} actif(s) · {treatments.filter((t) => !t.isActive).length} terminé(s)
            </p>
          </div>
          {writableMembers.length > 0 && (
            <Button onClick={openAdd}>
              <Plus size={16} />
              Nouveau traitement
            </Button>
          )}
        </div>

        {loading && treatments.length === 0 ? (
          <div className="flex justify-center py-20">
            <Loader2 className="animate-spin text-teal-600" size={36} />
          </div>
        ) : treatments.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-16 text-center">
            <div className="w-20 h-20 bg-violet-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Pill size={36} className="text-violet-400" />
            </div>
            <h3 className="text-lg font-bold text-gray-700 mb-2">Aucun traitement</h3>
            <p className="text-gray-400 mb-6">Enregistrez les traitements et médicaments de votre famille.</p>
            {members.length === 0 ? (
              <p className="text-sm text-amber-600 bg-amber-50 px-4 py-2 rounded-xl inline-block">
                ⚠️ Ajoutez d'abord un membre depuis la page Membres
              </p>
            ) : writableMembers.length > 0 ? (
              <Button onClick={openAdd}>
                <Plus size={16} />
                Ajouter un traitement
              </Button>
            ) : null}
          </div>
        ) : selection === null ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Recherche par membre : tous ses traitements */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sm:p-8 text-center">
              <div className="w-16 h-16 bg-violet-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <User size={30} className="text-violet-400" />
              </div>
              <h3 className="text-lg font-bold text-gray-700 mb-1">Par membre</h3>
              <p className="text-sm text-gray-400 mb-5">Choisissez un membre pour voir tous ses traitements.</p>
              <div className="flex flex-wrap justify-center gap-2">
                {readableMembers.map((m) => {
                  const count = treatmentCountOf(m.id);
                  return (
                    <button
                      key={m.id}
                      onClick={() => setSelection({ by: "member", value: m.id.toString() })}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border bg-white text-gray-600 border-gray-200 hover:border-violet-300 transition-all"
                    >
                      <MemberAvatar member={m} size="sm" />
                      {m.firstName}
                      <span className={`text-xs ${count > 0 ? "text-violet-600 font-semibold" : "text-gray-400"}`}>{count}</span>
                    </button>
                  );
                })}
                <button
                  onClick={() => setSelection({ by: "member", value: "all" })}
                  className="px-3 py-1.5 rounded-full text-sm font-medium border border-dashed border-gray-300 text-gray-500 hover:border-violet-300 hover:text-violet-600 transition-all"
                >
                  Tous les membres
                </button>
              </div>
            </div>

            {/* Recherche par maladie : les membres traités pour elle */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sm:p-8 text-center">
              <div className="w-16 h-16 bg-violet-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Stethoscope size={30} className="text-violet-400" />
              </div>
              <h3 className="text-lg font-bold text-gray-700 mb-1">Par maladie</h3>
              <p className="text-sm text-gray-400 mb-5">Choisissez une maladie pour voir les membres qui la traitent.</p>
              {diseases.length > DISEASE_SEARCH_THRESHOLD && (
                <div className="relative max-w-xs mx-auto mb-3">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="search"
                    value={diseaseQuery}
                    onChange={(e) => setDiseaseQuery(e.target.value)}
                    placeholder="Rechercher une maladie…"
                    className="w-full pl-8 pr-3 py-1.5 rounded-full border border-gray-200 bg-white text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>
              )}
              <div className="flex flex-wrap justify-center gap-2">
                {shownDiseases.map((d) => (
                  <button
                    key={d.key}
                    onClick={() => setSelection({ by: "disease", value: d.key })}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border bg-white text-gray-600 border-gray-200 hover:border-teal-300 transition-all"
                    title={`${d.memberIds.length} membre(s) · ${d.activeCount} traitement(s) en cours`}
                  >
                    {d.label}
                    <span className="text-xs text-gray-400">
                      {d.memberIds.length} membre{d.memberIds.length > 1 ? "s" : ""}
                    </span>
                  </button>
                ))}
                {shownDiseases.length === 0 && <p className="text-sm text-gray-400 italic">Aucune maladie ne correspond.</p>}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
              <span>
                {selection.by === "member" ? "Traitements de " : "Maladie : "}
                <span className="font-semibold text-gray-700">{selectionLabel}</span>
              </span>
              <button
                onClick={resetSelection}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-white border border-gray-200 text-gray-600 hover:border-violet-300 hover:text-violet-600 transition-colors"
              >
                Changer la sélection
              </button>
            </div>

            {/* Maladie choisie : les membres concernés, cliquables pour passer
                à l'ensemble de leurs traitements. */}
            {selectedDisease && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">
                  {selectedDisease.memberIds.length} membre{selectedDisease.memberIds.length > 1 ? "s" : ""} concerné
                  {selectedDisease.memberIds.length > 1 ? "s" : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  {selectedDisease.memberIds.map((id) => {
                    const m = getMember(id);
                    if (!m) return null;
                    const active = treatments.some((t) => t.memberId === id && t.isActive && diseaseKey(t.disease) === selectedDisease.key);
                    return (
                      <button
                        key={id}
                        onClick={() => setSelection({ by: "member", value: id.toString() })}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border bg-white text-gray-600 border-gray-200 hover:border-violet-300 transition-all"
                        title={`Voir tous les traitements de ${m.firstName}`}
                      >
                        <MemberAvatar member={m} size="sm" />
                        {m.firstName}
                        <Badge variant={active ? "success" : "default"}>{active ? "En cours" : "Terminé"}</Badge>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

          <div className="flex gap-2 flex-wrap">
            {[
              { value: "all", label: "Tous" },
              { value: "active", label: "En cours" },
              { value: "inactive", label: "Terminés" },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => setFilterActive(opt.value)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all ${
                  filterActive === opt.value ? "bg-teal-600 text-white shadow-sm" : "bg-white text-gray-600 border border-gray-200 hover:border-teal-300"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex justify-center py-20">
              <Loader2 className="animate-spin text-teal-600" size={36} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-16 text-center">
              <div className="w-20 h-20 bg-violet-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Pill size={36} className="text-violet-400" />
              </div>
              <h3 className="text-lg font-bold text-gray-700 mb-2">Aucun traitement ne correspond</h3>
              <p className="text-gray-400 mb-6">
                Aucun traitement{filterActive === "active" ? " en cours" : filterActive === "inactive" ? " terminé" : ""} pour {selectionLabel}.
              </p>
              {writableMembers.length > 0 && (
                <Button onClick={openAdd}>
                  <Plus size={16} />
                  Ajouter un traitement
                </Button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filtered.map((t) => {
                const member = getMember(t.memberId);
                const meds = t.medications ?? [];
                const status = treatmentStatus(t);
                const tracked = adherenceOf(t);
                return (
                  <div
                    key={t.id}
                    onClick={() => setViewing(t)}
                    className={`bg-white rounded-2xl shadow-sm border p-5 hover:shadow-md transition-all duration-200 cursor-pointer ${t.isActive ? "border-gray-100" : "border-gray-100 opacity-70"}`}
                    title="Cliquez pour voir les détails"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${t.isActive ? "bg-violet-100" : "bg-gray-100"}`}>
                          <Stethoscope size={20} className={t.isActive ? "text-violet-600" : "text-gray-400"} />
                        </div>
                        <div>
                          <h3 className="font-bold text-gray-800">{t.disease}</h3>
                          <p className="text-sm text-gray-500">
                            {meds.length === 0
                              ? "Aucun médicament"
                              : meds.length === 1
                              ? meds[0].name
                              : `${meds.length} médicaments`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <Badge variant={status.variant}>{status.label}</Badge>
                        {canWriteMember(t.memberId) && (
                          <button onClick={() => openEdit(t)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-teal-600 transition-colors">
                            <Pencil size={14} />
                          </button>
                        )}
                        {canWriteMember(t.memberId) && (
                          <button onClick={() => deleteTreatmentFromCard(t.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>

                    <TodayIntakes intakes={todayIntakesOf(t.id)} canAnswer={canAnswer} />

                    {meds.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {meds.slice(0, 3).map((m, i) => (
                          <span key={i} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 font-medium">
                            <Pill size={10} />
                            {m.name}
                            {normalizeTimes(m.intakeTimes).length > 0 ? (
                              <span className="text-violet-500 font-normal">({formatIntakeTimes(m.intakeTimes)})</span>
                            ) : (
                              t.isActive && <span className="text-amber-600 font-normal">(aucun rappel)</span>
                            )}
                          </span>
                        ))}
                        {meds.length > 3 && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-50 text-gray-500 font-medium">+{meds.length - 3}</span>
                        )}
                      </div>
                    )}

                    {/* Taux de suivi sur 30 jours (médicaments avec heures de prise) */}
                    {tracked.length > 0 && (
                      <div className="mb-2 space-y-0.5">
                        {tracked.slice(0, 3).map(({ med, adherence }, i) => (
                          <AdherenceCompact key={med.id ?? i} name={tracked.length > 1 ? med.name : null} adherence={adherence} />
                        ))}
                        {tracked.length > 3 && <p className="text-xs text-gray-400">+{tracked.length - 3} autre(s)</p>}
                      </div>
                    )}

                    <div className="space-y-1.5 text-sm text-gray-500">
                      {(t.startDate || t.endDate) && (
                        <p className="flex items-center gap-2">
                          <Calendar size={13} className="text-teal-500" />
                          {t.startDate ? formatDate(t.startDate) : "—"} → {t.endDate ? formatDate(t.endDate) : "En cours"}
                        </p>
                      )}
                      {t.prescribedBy && (
                        <p className="flex items-center gap-2">
                          <User size={13} className="text-teal-500" />
                          Prescrit par {t.prescribedBy}
                        </p>
                      )}
                      {t.notes && <p className="text-xs bg-gray-50 rounded-lg px-2 py-1 italic mt-2">{t.notes}</p>}
                    </div>

                    {member && (
                      <div className="mt-3 pt-3 border-t border-gray-50">
                        <MemberAvatar member={member} size="sm" showName />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          </>
        )}
      </div>

      {/* Modal de détails du traitement */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title="Détails du traitement" size="lg">
        {viewing && (
          <div className="space-y-6">
            {/* En-tête : maladie */}
            <div className="bg-gradient-to-r from-violet-50 to-purple-50 rounded-2xl p-5 border border-violet-100">
              <div className="flex items-center gap-4">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 ${viewing.isActive ? "bg-violet-100" : "bg-gray-100"}`}>
                  <Stethoscope size={26} className={viewing.isActive ? "text-violet-600" : "text-gray-400"} />
                </div>
                <div className="flex-1">
                  <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">Maladie / motif</p>
                  <h3 className="text-lg font-bold text-gray-800">{viewing.disease}</h3>
                  <div className="mt-1">
                    <Badge variant={treatmentStatus(viewing, "En cours").variant}>{treatmentStatus(viewing, "En cours").label}</Badge>
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

            {/* Médicaments : maladie + posologie + fréquence + durée, alignés */}
            <div>
              <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">
                Médicaments ({(viewing.medications ?? []).length})
              </h4>
              {(viewing.medications ?? []).length === 0 ? (
                <p className="text-sm text-gray-400 italic">Aucun médicament renseigné.</p>
              ) : (
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="grid grid-cols-5 gap-2 bg-gray-50 px-3 py-2 text-xs font-bold text-gray-500 uppercase tracking-wide">
                    <span>Médicament</span>
                    <span>Posologie</span>
                    <span>Heures de prise</span>
                    <span>Fréquence</span>
                    <span>Durée</span>
                  </div>
                  {viewing.medications.map((m, i) => (
                    <div key={m.id ?? i} className={`grid grid-cols-5 gap-2 px-3 py-2.5 text-sm ${i % 2 === 1 ? "bg-gray-50/60" : "bg-white"}`}>
                      <span className="font-semibold text-gray-800 flex items-center gap-1.5">
                        <Pill size={12} className="text-violet-500 flex-shrink-0" />
                        {m.name}
                      </span>
                      <span className="text-gray-600">{m.dosage || "—"}</span>
                      <span className="text-gray-600">{formatIntakeTimes(m.intakeTimes) || "—"}</span>
                      <span className="text-gray-600">{m.frequency || "—"}</span>
                      <span className="text-gray-600">{m.duration || "—"}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Taux de suivi par médicament (30 derniers jours) */}
            {adherenceOf(viewing).length > 0 && (
              <div>
                <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Suivi des prises (30 derniers jours)</h4>
                <div className="space-y-3">
                  {adherenceOf(viewing).map(({ med, adherence }, i) => (
                    <div key={med.id ?? i} className="bg-gray-50 rounded-xl p-3">
                      <p className="text-sm font-semibold text-gray-800 flex items-center gap-1.5 mb-1.5">
                        <Pill size={12} className="text-violet-500 flex-shrink-0" />
                        {med.name}
                        {med.dosage && <span className="font-normal text-gray-400">({med.dosage})</span>}
                      </p>
                      <AdherenceBar adherence={adherence} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Informations générales du traitement */}
            <div>
              <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Informations générales</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {viewing.startDate && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium">Date de début</p>
                    <p className="text-sm font-semibold text-gray-700">{formatDate(viewing.startDate)}</p>
                  </div>
                )}
                {viewing.endDate ? (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium">Date de fin</p>
                    <p className="text-sm font-semibold text-gray-700">{formatDate(viewing.endDate)}</p>
                  </div>
                ) : viewing.isActive && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium">Date de fin</p>
                    <p className="text-sm font-semibold text-emerald-600">En cours</p>
                  </div>
                )}
                {viewing.prescribedBy && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium flex items-center gap-1">
                      <User size={11} /> Prescrit par
                    </p>
                    <p className="text-sm font-semibold text-gray-700">{viewing.prescribedBy}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Historique des prises */}
            <div>
              <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <History size={14} className="text-violet-500" /> Historique des prises ({HISTORY_DAYS} derniers jours)
              </h4>
              <IntakeHistory intakes={recentIntakesOf(viewing.id)} canAnswer={canAnswer} />
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
            <div className="flex gap-3 pt-2 border-t border-gray-100">
              {canWriteMember(viewing.memberId) && (
                <Button variant="ghost" onClick={() => deleteTreatment(viewing.id)} className="flex-1 text-red-500 hover:bg-red-50">
                  <Trash2 size={15} />
                  Supprimer
                </Button>
              )}
              {canWriteMember(viewing.memberId) && (
                <Button variant="ghost" onClick={() => openEdit(viewing)} className="flex-1">
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

      {/* Modal d'ajout / modification */}
      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? "Modifier le traitement" : "Nouveau traitement"} size="lg">
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

          <Input label="Maladie / motif du traitement *" placeholder="Paludisme, hypertension, grippe..." value={form.disease} onChange={f("disease")} />

          {/* Liste des médicaments — un traitement peut en concerner plusieurs */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-semibold text-gray-700">Médicaments *</label>
              <button
                type="button"
                onClick={addMedicationRow}
                className="inline-flex items-center gap-1 text-xs font-semibold text-teal-600 hover:text-teal-700"
              >
                <Plus size={14} />
                Ajouter un médicament
              </button>
            </div>

            <div className="space-y-3">
              {form.medications.map((m, i) => (
                <div key={i} className="border border-gray-200 rounded-xl p-3 bg-gray-50/60 relative">
                  {form.medications.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeMedicationRow(i)}
                      className="absolute top-2 right-2 p-1 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                      title="Retirer ce médicament"
                    >
                      <X size={14} />
                    </button>
                  )}
                  <Input
                    label={`Médicament ${i + 1}`}
                    placeholder="Amoxicilline, Paracétamol..."
                    value={m.name}
                    onChange={(e) => updateMedication(i, "name", e.target.value)}
                  />
                  <div className="grid grid-cols-3 gap-3 mt-3">
                    <Input label="Posologie" placeholder="500mg" value={m.dosage} onChange={(e) => updateMedication(i, "dosage", e.target.value)} />
                    <Input label="Fréquence" placeholder="2x/jour" value={m.frequency} onChange={(e) => updateMedication(i, "frequency", e.target.value)} />
                    <Input label="Durée" placeholder="7 jours" value={m.duration} onChange={(e) => updateMedication(i, "duration", e.target.value)} />
                  </div>
                  <IntakeTimesEditor value={m.intakeTimes} onChange={(times) => updateMedication(i, "intakeTimes", times)} />
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input label="Date de début" type="date" value={form.startDate} onChange={f("startDate")} />
            <Input label="Date de fin" type="date" value={form.endDate} onChange={f("endDate")} />
          </div>
          <Input label="Prescrit par" placeholder="Dr. Martin" value={form.prescribedBy} onChange={f("prescribedBy")} />
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="isActive"
              checked={form.isActive}
              onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.checked }))}
              className="w-4 h-4 rounded text-teal-600"
            />
            <label htmlFor="isActive" className="text-sm font-semibold text-gray-700">
              Traitement en cours
            </label>
          </div>
          <Textarea label="Notes" placeholder="Instructions, effets secondaires..." value={form.notes} onChange={f("notes")} />
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