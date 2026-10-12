import { useState } from "react";
import { Check, X } from "lucide-react";
import toast from "react-hot-toast";
import { respondIntake } from "../notifications/intakes";
import { cn } from "../../lib/utils";

// Très grands boutons « Pris » / « Pas pris » du mode senior (UC-25) —
// mêmes routes que les petits boutons (POST /api/intakes/:id/respond).
// `onDone(updated)` après une réponse enregistrée.
export function BigIntakeButtons({ intakeId, onDone, className }) {
  const [busy, setBusy] = useState(null);

  const answer = async (status) => {
    if (busy) return;
    setBusy(status);
    const updated = await respondIntake(intakeId, status);
    setBusy(null);
    if (updated) {
      toast.success(status === "taken" ? "C'est noté : médicament pris" : "C'est noté : médicament pas pris");
      onDone?.(updated);
    }
  };

  const base =
    "flex-1 inline-flex items-center justify-center gap-2 min-h-[3.5rem] px-5 py-3 rounded-2xl text-xl font-bold " +
    "transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-4";

  return (
    <div className={cn("flex gap-3", className)}>
      <button
        type="button"
        disabled={!!busy}
        onClick={() => answer("taken")}
        className={cn(base, "bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-300")}
      >
        <Check size={28} strokeWidth={3} />
        Pris
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={() => answer("not_taken")}
        className={cn(base, "bg-white text-red-700 border-4 border-red-300 hover:bg-red-50 focus-visible:ring-red-300")}
      >
        <X size={28} strokeWidth={3} />
        Pas pris
      </button>
    </div>
  );
}
