import { AlertTriangle, Bell, CalendarClock, CheckCircle, PhoneCall, Pill, Syringe } from "lucide-react";
import { cn, formatTimeAgo } from "../../lib/utils";
import { IntakeAnswerButtons, IntakeStatusBadge } from "./intakes";

// Icône et couleurs par catégorie de notification.
const CATEGORY_STYLES = {
  appointment_reminder: { icon: CalendarClock, className: "bg-blue-50 text-blue-600" },
  medication_intake: { icon: Pill, className: "bg-violet-50 text-violet-600" },
  vaccine_reminder: { icon: Syringe, className: "bg-amber-50 text-amber-600" },
  delivery_failure: { icon: AlertTriangle, className: "bg-red-50 text-red-600" },
  // Village : rappels relayés aux proches non connectés
  relay_to_relay: { icon: PhoneCall, className: "bg-teal-50 text-teal-600" },
  relay_escalation: { icon: PhoneCall, className: "bg-orange-50 text-orange-600" },
  relay_alert: { icon: AlertTriangle, className: "bg-amber-50 text-amber-600" },
  relay_update: { icon: CheckCircle, className: "bg-emerald-50 text-emerald-600" },
};

// Une notification (cloche et historique). `onOpen` est appelé au clic
// (marquer comme lue + navigation) ; `onAnswered` après une réponse à une
// prise de médicament.
export function NotificationItem({ notification: n, onOpen, onAnswered, compact = false }) {
  const style = CATEGORY_STYLES[n.category] ?? { icon: Bell, className: "bg-gray-100 text-gray-500" };
  const Icon = style.icon;
  const unread = !n.readAt;
  const isFailure = n.category === "delivery_failure";
  const isIntake = n.category === "medication_intake" && n.intakeId;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(n)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen?.(n);
      }}
      className={cn(
        "flex gap-3 px-4 py-3 cursor-pointer transition-colors text-left",
        compact ? "hover:bg-gray-50" : "rounded-xl hover:bg-gray-50",
        unread && (isFailure ? "bg-red-50/40" : "bg-teal-50/40")
      )}
    >
      <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0", style.className)}>
        <Icon size={17} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <p className={cn("text-sm flex-1 min-w-0 break-words", unread ? "font-bold text-gray-800" : "font-medium text-gray-700", isFailure && "text-red-700")}>
            {n.title}
          </p>
          {unread && <span className={cn("mt-1.5 w-2 h-2 rounded-full flex-shrink-0", isFailure ? "bg-red-500" : "bg-teal-500")} title="Non lue" />}
        </div>
        {n.body && (
          <p className={cn("text-xs mt-0.5 break-words", isFailure ? "text-red-600" : "text-gray-500")}>{n.body}</p>
        )}
        <div className="flex items-center justify-between gap-2 mt-1.5 flex-wrap">
          <span className="text-[11px] text-gray-400">{formatTimeAgo(n.createdAt)}</span>
          {isIntake &&
            (n.intakeStatus === "pending" ? (
              <IntakeAnswerButtons intakeId={n.intakeId} onDone={() => onAnswered?.(n)} />
            ) : (
              <IntakeStatusBadge status={n.intakeStatus} />
            ))}
        </div>
      </div>
    </div>
  );
}
