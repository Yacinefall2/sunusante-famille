import { cn } from "../../lib/utils";
import { OFFLINE_HINT, useOnline } from "../../lib/offline";

// Interrupteur marche / arrêt accessible (role="switch"). `label` est lu par
// les lecteurs d'écran ; afficher le texte visible à côté si besoin.
// Chaque bascule enregistre un réglage : désactivé hors ligne (§10), sauf
// `offlineOk` (réglage propre à l'appareil).
export function Switch({ checked, onChange, disabled, label, className, offlineOk = false }) {
  const online = useOnline();
  const blocked = !offlineOk && !online;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      disabled={disabled || blocked}
      title={blocked ? OFFLINE_HINT : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onChange?.(!checked);
      }}
      className={cn(
        "senior-switch relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-teal-600" : "bg-gray-300",
        className
      )}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-6" : "translate-x-1"
        )}
      />
    </button>
  );
}
