import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, Check, X } from "lucide-react";
import toast from "react-hot-toast";
import { useFamily } from "../../context/FamilyContext";
import { Button } from "../ui/Button";
import { formatDate } from "../../lib/utils";
import { NOTIFICATIONS_REFRESH_EVENT, notifyNotificationsChanged } from "../notifications/intakes";

// Encadré « Proposition de transfert » (UC-39) : propositions de reprendre la
// gestion d'un dossier reçues par l'utilisateur, à accepter ou refuser.
// Affiché sur le tableau de bord et la page Notifications ; rien si aucune
// proposition n'est en attente. `onChange` : appelé après une réponse.
export function RoleTransferInbox({ onChange, className = "" }) {
  const { selectedFamily, reloadMembers } = useFamily();
  const [received, setReceived] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    if (!selectedFamily) return setReceived([]);
    try {
      const res = await fetch(`/api/role-transfers?familyId=${selectedFamily.id}`);
      const data = await res.json().catch(() => null);
      setReceived(res.ok && Array.isArray(data?.received) ? data.received : []);
    } catch {
      setReceived([]);
    }
  }, [selectedFamily]);

  useEffect(() => {
    load();
    window.addEventListener(NOTIFICATIONS_REFRESH_EVENT, load);
    return () => window.removeEventListener(NOTIFICATIONS_REFRESH_EVENT, load);
  }, [load]);

  const answer = async (transfer, action) => {
    setBusyId(transfer.id);
    try {
      const res = await fetch(`/api/role-transfers/${transfer.id}/${action}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "La réponse n'a pas pu être enregistrée");
      } else if (action === "accept") {
        toast.success(`Vous êtes désormais gestionnaire du dossier de ${transfer.memberName}`);
      } else {
        toast.success("Proposition refusée");
      }
      await load();
      reloadMembers();
      notifyNotificationsChanged();
      onChange?.();
    } finally {
      setBusyId(null);
    }
  };

  if (received.length === 0) return null;

  return (
    <div className={`bg-white rounded-2xl shadow-sm border border-teal-200 p-5 space-y-3 ${className}`}>
      <h3 className="font-bold text-gray-800 flex items-center gap-2">
        <ArrowRightLeft size={18} className="text-teal-600" />
        Proposition{received.length > 1 ? "s" : ""} de transfert
      </h3>
      {received.map((t) => (
        <div
          key={t.id}
          className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-xl bg-teal-50/60 border border-teal-100"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-800">
              {t.fromName} vous propose de reprendre la gestion du dossier de {t.memberName}
            </p>
            <p className="text-xs text-gray-500">
              En acceptant, vous saisirez et gérerez son dossier
              {" "}(rendez-vous, traitements, rappels du Village). Proposition valable jusqu&apos;au {formatDate(t.expiresAt)}.
            </p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <Button size="sm" variant="ghost" onClick={() => answer(t, "decline")} disabled={busyId === t.id}>
              <X size={14} />
              Refuser
            </Button>
            <Button size="sm" onClick={() => answer(t, "accept")} loading={busyId === t.id}>
              <Check size={14} />
              Accepter
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
