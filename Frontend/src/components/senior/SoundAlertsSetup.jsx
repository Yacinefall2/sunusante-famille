import { useState } from "react";
import { BellRing, Volume2, CheckCircle2, AlertTriangle } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import {
  alertsEnabled,
  audioSupported,
  enableAlerts,
  notificationPermission,
  playAlertSound,
  unlockAudio,
} from "../../lib/seniorAlerts";

export const APP_OPEN_HELP =
  "Les alertes sonores fonctionnent quand SunuSanté Famille est ouverte sur votre téléphone ou votre ordinateur.";

// Activation des alertes sonores du mode senior (UC-25) et bouton « Tester le
// son ». Les navigateurs exigent un appui de la personne avant tout son : c'est
// le rôle du bouton « Activer les alertes sonores », qui demande aussi — une
// seule fois — l'autorisation d'afficher des notifications.
// `onlyIfDisabled` : n'affiche rien une fois les alertes activées (accueil).
export function SoundAlertsSetup({ onlyIfDisabled = false, className }) {
  const [enabled, setEnabled] = useState(alertsEnabled());
  const [permission, setPermission] = useState(notificationPermission());
  const [busy, setBusy] = useState(false);

  if (onlyIfDisabled && enabled) return null;

  const activate = async () => {
    setBusy(true);
    try {
      const { audioOk, permission: p } = await enableAlerts();
      setEnabled(true);
      setPermission(p);
      if (audioOk) toast.success("Alertes sonores activées");
      else toast.error("Le son ne peut pas être joué sur cet appareil");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    await unlockAudio();
    const ok = await playAlertSound();
    if (!ok) toast.error("Le son n'a pas pu être joué : vérifiez le volume de l'appareil");
  };

  if (!audioSupported()) {
    return (
      <p className={cn("text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3", className)}>
        Ce navigateur ne peut pas jouer les alertes sonores.
      </p>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {!enabled ? (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4 space-y-3">
          <p className="font-semibold text-gray-800 flex items-start gap-2">
            <BellRing className="text-amber-600 flex-shrink-0 mt-0.5" size={20} />
            Pour entendre les rappels de médicaments et de rendez-vous, activez les alertes sonores.
          </p>
          <p className="text-sm text-gray-700">
            Votre navigateur va vous demander l'autorisation d'afficher des notifications : répondez « Autoriser ».
          </p>
          <div className="flex flex-wrap gap-3">
            <Button size="lg" onClick={activate} loading={busy}>
              <BellRing size={20} />
              Activer les alertes sonores
            </Button>
            <Button size="lg" variant="outline" onClick={test}>
              <Volume2 size={20} />
              Tester le son
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-700">
            <CheckCircle2 size={18} />
            Alertes sonores activées sur cet appareil
          </span>
          <Button variant="outline" onClick={test}>
            <Volume2 size={18} />
            Tester le son
          </Button>
        </div>
      )}
      {enabled && permission === "denied" && (
        <p className="text-sm text-amber-800 flex items-start gap-2">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          Les notifications du navigateur sont bloquées : le son et la grande alerte à l'écran restent actifs. Pour les
          autoriser, ouvrez les réglages du site dans votre navigateur.
        </p>
      )}
      <p className="text-xs text-gray-500">{APP_OPEN_HELP}</p>
    </div>
  );
}
