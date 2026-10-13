import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { CloudOff, Info } from "lucide-react";
import { NOT_CACHED_MESSAGE, formatOfflineDate, lastSyncAt, resetPageOfflineState, useOfflineState } from "../../lib/offline";

// Bandeau « Hors ligne — données du 13/10 à 14:05 » (cahier des charges §10) :
// date de la plus ancienne donnée affichée depuis le cache, ou à défaut de
// la dernière synchronisation avec le serveur. Signale aussi une page jamais
// consultée sur cet appareil, dont les données ne peuvent pas être montrées.
export function OfflineBanner() {
  const { pathname } = useLocation();
  const { offline, oldestDataAt, missing } = useOfflineState();

  useEffect(() => {
    resetPageOfflineState();
  }, [pathname]);

  if (!offline) return null;
  const when = formatOfflineDate(oldestDataAt || lastSyncAt());

  return (
    <div role="status" aria-live="polite" className="space-y-2 mb-4">
      <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
        <CloudOff size={18} className="flex-shrink-0 mt-0.5" />
        <p>
          <strong>Hors ligne</strong>
          {when ? ` — données du ${when}` : ""}. Consultation seulement : les modifications demandent une connexion.
        </p>
      </div>
      {missing && (
        <div className="flex items-start gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-700">
          <Info size={18} className="flex-shrink-0 mt-0.5 text-gray-500" />
          <p>{NOT_CACHED_MESSAGE}.</p>
        </div>
      )}
    </div>
  );
}
