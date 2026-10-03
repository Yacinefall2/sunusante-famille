import { useState } from "react";
import { Check, X } from "lucide-react";
import toast from "react-hot-toast";
import { Badge } from "../ui/Badge";
import { cn } from "../../lib/utils";

// Statuts d'une prise de médicament, tels que renvoyés par le serveur.
export const INTAKE_STATUSES = {
  pending: { label: "En attente", variant: "warning" },
  taken: { label: "Pris", variant: "success" },
  not_taken: { label: "Pas pris", variant: "danger" },
  missed: { label: "Sans réponse", variant: "default" },
};

// Événement global : demande aux composants concernés (cloche, page
// Notifications) de recharger leurs données après une action ailleurs.
export const NOTIFICATIONS_REFRESH_EVENT = "notifications:refresh";

export function notifyNotificationsChanged() {
  window.dispatchEvent(new Event(NOTIFICATIONS_REFRESH_EVENT));
}

// Enregistre la réponse à une prise ("taken" | "not_taken").
// Renvoie la prise mise à jour, ou null en cas d'échec (toast affiché).
export async function respondIntake(intakeId, status) {
  try {
    const res = await fetch(`/api/intakes/${intakeId}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Impossible d'enregistrer la réponse");
      return null;
    }
    const updated = await res.json().catch(() => ({}));
    notifyNotificationsChanged();
    return updated;
  } catch {
    toast.error("Impossible d'enregistrer la réponse");
    return null;
  }
}

export function IntakeStatusBadge({ status, className }) {
  const s = INTAKE_STATUSES[status];
  if (!s) return null;
  return (
    <Badge variant={s.variant} className={cn("px-2 py-0.5", className)}>
      {s.label}
    </Badge>
  );
}

// Boutons "Pris" / "Pas pris" pour une prise en attente. `onDone` est
// appelé après une réponse enregistrée avec succès.
export function IntakeAnswerButtons({ intakeId, onDone, className }) {
  const [busy, setBusy] = useState(null);

  const answer = async (e, status) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(status);
    const updated = await respondIntake(intakeId, status);
    setBusy(null);
    if (updated) {
      toast.success(status === "taken" ? "Prise enregistrée" : "Prise non effectuée enregistrée");
      onDone?.(updated);
    }
  };

  const base =
    "inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className={cn("flex items-center gap-1.5", className)} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={!!busy}
        onClick={(e) => answer(e, "taken")}
        className={cn(base, "bg-emerald-600 text-white hover:bg-emerald-700")}
      >
        <Check size={12} />
        Pris
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={(e) => answer(e, "not_taken")}
        className={cn(base, "bg-white text-red-600 border border-red-200 hover:bg-red-50")}
      >
        <X size={12} />
        Pas pris
      </button>
    </div>
  );
}
