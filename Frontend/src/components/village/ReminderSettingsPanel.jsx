import { useEffect, useState } from "react";
import { BellRing, Loader2, RotateCcw } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "../ui/Button";
import { Select } from "../ui/Input";

// « Règles de rappel du Village » (UC-08) — réservé aux parents (A1, A2).
// Quatre réglages encadrés, l'enchaînement expliqué, un aperçu en phrase mis
// à jour à chaque choix, Enregistrer et Rétablir les valeurs par défaut.
// Les bornes sont aussi vérifiées par le serveur (routes/reminderSettings.js).

const DEFAULTS = { relayFirstDays: 3, followUpDaysBefore: 1, escalationDelayHours: 3, attendancePrompt: "same_evening" };
const range = (min, max) => Array.from({ length: max - min + 1 }, (_, i) => min + i);

const FOLLOW_UP_LABEL = { 1: "la veille", 2: "2 jours avant" };
const ATTENDANCE_LABEL = {
  same_evening: "le soir même (12 h après le rendez-vous)",
  next_morning: "le lendemain matin (8 h)",
};

// « 3 jours avant : “à relayer” aux gestionnaires → la veille : relance → … »
export function reminderSentence(s) {
  return (
    `${s.relayFirstDays} jours avant : « à relayer » aux gestionnaires → ${FOLLOW_UP_LABEL[s.followUpDaysBefore]} : relance → ` +
    `${s.escalationDelayHours} h plus tard sans « Prévenu » : escalade vers les relais → ` +
    `${s.attendancePrompt === "next_morning" ? "le lendemain matin" : "le soir même"} : « s'y est-il rendu ? »`
  );
}

export function ReminderSettingsPanel({ familyId }) {
  const [form, setForm] = useState(DEFAULTS);
  const [isDefault, setIsDefault] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const apply = (data) => {
    setForm({
      relayFirstDays: data.relayFirstDays,
      followUpDaysBefore: data.followUpDaysBefore,
      escalationDelayHours: data.escalationDelayHours,
      attendancePrompt: data.attendancePrompt,
    });
    setIsDefault(!!data.isDefault);
  };

  useEffect(() => {
    if (!familyId) return;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/reminder-settings?familyId=${familyId}`);
        const data = await res.json().catch(() => null);
        if (res.ok && data) apply(data);
        else toast.error(data?.error || "Impossible de charger les règles de rappel");
      } catch {
        toast.error("Impossible de charger les règles de rappel");
      } finally {
        setLoading(false);
      }
    })();
  }, [familyId]);

  const set = (key, value) =>
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // La relance vient toujours après le premier « à relayer ».
      if (next.followUpDaysBefore >= next.relayFirstDays) next.followUpDaysBefore = 1;
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/reminder-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ familyId, ...form }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Les règles n'ont pas pu être enregistrées");
        return;
      }
      apply(data);
      toast.success("Règles de rappel enregistrées");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!confirm("Rétablir les règles de rappel par défaut ?")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/reminder-settings?familyId=${familyId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Le rétablissement a échoué");
        return;
      }
      apply(data);
      toast.success("Valeurs par défaut rétablies");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
        <BellRing size={16} className="text-teal-600" />
        <h3 className="font-bold text-gray-800 text-sm">Règles de rappel du Village</h3>
        {!loading && isDefault && <span className="text-xs text-gray-400">(valeurs par défaut)</span>}
      </div>
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="animate-spin text-teal-600" size={24} />
        </div>
      ) : (
        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-gray-600">
            Pour un proche sans compte, les rendez-vous sont relayés par la famille : les gestionnaires sont prévenus, puis
            relancés ; sans « Prévenu », les relais sont sollicités ; après le rendez-vous, on demande s&apos;il s&apos;y est
            rendu. Choisissez le rythme qui convient à votre famille.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select
              label="Premier « à relayer » aux gestionnaires"
              value={form.relayFirstDays}
              onChange={(e) => set("relayFirstDays", Number(e.target.value))}
            >
              {range(2, 7).map((n) => (
                <option key={n} value={n}>
                  {n} jours avant le rendez-vous
                </option>
              ))}
            </Select>
            <Select
              label="Relance des gestionnaires"
              value={form.followUpDaysBefore}
              onChange={(e) => set("followUpDaysBefore", Number(e.target.value))}
            >
              {[1, 2]
                .filter((n) => n < form.relayFirstDays)
                .map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? "La veille" : "2 jours avant"}
                  </option>
                ))}
            </Select>
            <Select
              label="Escalade vers les relais sans « Prévenu »"
              value={form.escalationDelayHours}
              onChange={(e) => set("escalationDelayHours", Number(e.target.value))}
            >
              {range(1, 12).map((n) => (
                <option key={n} value={n}>
                  {n} h après la relance
                </option>
              ))}
            </Select>
            <Select
              label="Question « s'y est-il rendu ? »"
              value={form.attendancePrompt}
              onChange={(e) => set("attendancePrompt", e.target.value)}
            >
              {Object.entries(ATTENDANCE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label.charAt(0).toUpperCase() + label.slice(1)}
                </option>
              ))}
            </Select>
          </div>
          {/* Aperçu de l'enchaînement, mis à jour à chaque choix */}
          <p className="text-sm text-teal-900 bg-teal-50 border border-teal-100 rounded-xl px-3 py-2" aria-live="polite">
            {reminderSentence(form)}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 sm:justify-end">
            <Button variant="ghost" onClick={reset} disabled={saving || isDefault}>
              <RotateCcw size={14} />
              Rétablir les valeurs par défaut
            </Button>
            <Button onClick={save} loading={saving}>
              Enregistrer
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
