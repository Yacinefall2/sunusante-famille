import { useCallback, useEffect, useState } from "react";
import { BellOff, BellRing, CheckCircle2, Info, Loader2, Send, Smartphone, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Switch } from "../ui/Switch";
import { formatDateTime } from "../../lib/utils";
import { useOnline } from "../../lib/offline";
import { currentPushSubscription, isIos, pushSupported, subscribeThisDevice, unsubscribeThisDevice, useInstallState } from "../../lib/pwa";

// Section « Cet appareil » de la page Notifications : rappels reçus même
// quand l'application est fermée (notifications push), et liste des
// appareils abonnés du compte.
export function DevicePushSection() {
  const online = useOnline();
  const installState = useInstallState();
  const supported = pushSupported();
  const [serverEnabled, setServerEnabled] = useState(null);
  const [devices, setDevices] = useState([]);
  const [endpoint, setEndpoint] = useState(null); // abonnement de CET appareil
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [permission, setPermission] = useState(typeof Notification !== "undefined" ? Notification.permission : "unsupported");

  const load = useCallback(async () => {
    try {
      const [keyRes, listRes, sub] = await Promise.all([
        fetch("/api/push/public-key"),
        fetch("/api/push/subscriptions"),
        currentPushSubscription().catch(() => null),
      ]);
      if (keyRes.ok) setServerEnabled(!!(await keyRes.json()).enabled);
      if (listRes.ok) {
        const list = await listRes.json();
        setDevices(Array.isArray(list) ? list : []);
      }
      setEndpoint(sub?.endpoint ?? null);
    } catch {
      // hors ligne : la section l'indique
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const thisDevice = endpoint ? devices.find((d) => d.endpoint === endpoint) : null;
  const subscribed = !!thisDevice;

  const run = async (key, action, success) => {
    setBusy(key);
    try {
      await action();
      if (success) toast.success(success);
    } catch (e) {
      toast.error(e.message || "Erreur");
    } finally {
      setBusy(null);
      if (typeof Notification !== "undefined") setPermission(Notification.permission);
      await load();
    }
  };

  const subscribe = () =>
    run("subscribe", () => subscribeThisDevice({ hideDetails: false }), "Cet appareil recevra les rappels");

  const unsubscribe = () => run("unsubscribe", unsubscribeThisDevice, "Cet appareil ne recevra plus les rappels");

  const sendTest = () =>
    run(
      "test",
      async () => {
        const res = await fetch("/api/push/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Envoi impossible");
      },
      "Notification de test envoyée : elle arrive dans quelques secondes"
    );

  const setHideDetails = (value) =>
    run(
      "hide",
      async () => {
        const res = await fetch(`/api/push/subscriptions/${thisDevice.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hideDetails: value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Erreur lors de l'enregistrement");
      },
      value ? "Détail masqué sur l'écran verrouillé" : "Détail affiché sur l'écran verrouillé"
    );

  const remove = (device) =>
    run(
      `remove-${device.id}`,
      async () => {
        if (device.endpoint === endpoint) return unsubscribeThisDevice();
        const res = await fetch(`/api/push/subscriptions/${device.id}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Impossible de retirer cet appareil");
      },
      "Appareil retiré"
    );

  // État de cet appareil
  let status;
  if (!supported) {
    status =
      isIos() && installState !== "installed"
        ? { variant: "warning", label: "Installez d'abord l'application" }
        : { variant: "default", label: "Non pris en charge" };
  } else if (permission === "denied") status = { variant: "danger", label: "Notifications refusées" };
  else if (subscribed) status = { variant: "success", label: "Abonné" };
  else status = { variant: "default", label: "Non abonné" };

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
      <h2 className="font-bold text-gray-800 flex items-center gap-2 mb-1">
        <Smartphone size={18} className="text-teal-600" /> Cet appareil
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        Recevez les rappels de médicaments, de rendez-vous et du Village sur ce téléphone ou cet ordinateur, même
        application fermée.
      </p>

      {loading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="animate-spin text-teal-500" size={24} />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-700">État :</span>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>

          {serverEnabled === false && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
              Les notifications push ne sont pas encore activées sur ce serveur (clés VAPID absentes). Les rappels restent
              visibles dans la cloche et par courriel.
            </p>
          )}

          {!supported ? (
            <p className="text-sm text-gray-600">
              {isIos()
                ? "Sur iPhone et iPad, les rappels ne peuvent arriver que si l'application est installée sur l'écran d'accueil (iOS 16.4 ou plus récent) : voir « Mon compte », puis ouvrez-la depuis son icône."
                : "Ce navigateur ne peut pas recevoir de notifications push. Essayez Chrome, Edge, Firefox ou Safari récents."}
            </p>
          ) : permission === "denied" ? (
            <p className="text-sm text-gray-600">
              Les notifications sont bloquées pour SunuSanté Famille : autorisez-les dans les réglages du site de votre
              navigateur, puis revenez ici.
            </p>
          ) : (
            serverEnabled && (
              <div className="flex flex-wrap gap-3">
                {subscribed ? (
                  <>
                    <Button variant="outline" onClick={sendTest} loading={busy === "test"}>
                      <Send size={16} />
                      Envoyer une notification de test
                    </Button>
                    <Button variant="ghost" onClick={unsubscribe} loading={busy === "unsubscribe"}>
                      <BellOff size={16} />
                      Ne plus recevoir les rappels ici
                    </Button>
                  </>
                ) : (
                  <Button onClick={subscribe} loading={busy === "subscribe"}>
                    <BellRing size={16} />
                    Recevoir les rappels sur cet appareil
                  </Button>
                )}
              </div>
            )
          )}

          {subscribed && (
            <div className="flex items-start gap-4 border-t border-gray-100 pt-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800">Masquer le détail sur l&apos;écran verrouillé</p>
                <p className="text-xs text-gray-500">
                  Les notifications de cet appareil affichent seulement « Rappel SunuSanté Famille », sans nom de
                  médicament ni de proche (et sans les boutons Pris / Pas pris).
                </p>
              </div>
              <Switch
                checked={!!thisDevice.hideDetails}
                onChange={setHideDetails}
                disabled={busy === "hide"}
                label="Masquer le détail sur l'écran verrouillé"
              />
            </div>
          )}

          {devices.length > 0 && (
            <div className="border-t border-gray-100 pt-4">
              <h3 className="text-sm font-bold text-gray-800 mb-2">Mes appareils</h3>
              <ul className="divide-y divide-gray-100 border border-gray-100 rounded-xl">
                {devices.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-3 py-2.5">
                    <Smartphone size={16} className="text-gray-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-800 flex items-center gap-2 flex-wrap">
                        {d.label || "Appareil"}
                        {d.endpoint === endpoint && (
                          <Badge variant="info" className="px-2 py-0.5">
                            Cet appareil
                          </Badge>
                        )}
                      </p>
                      <p className="text-xs text-gray-500">
                        Ajouté le {formatDateTime(d.createdAt)}
                        {d.lastSuccessAt ? ` · dernier rappel envoyé le ${formatDateTime(d.lastSuccessAt)}` : ""}
                      </p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => remove(d)} loading={busy === `remove-${d.id}`}>
                      <Trash2 size={14} />
                      Retirer
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="text-xs text-gray-500 space-y-1.5 border-t border-gray-100 pt-4">
            <p className="flex items-start gap-1.5">
              <Info size={13} className="text-teal-500 flex-shrink-0 mt-0.5" />
              Application ouverte, même sans réseau : les prises du jour déjà affichées sur cet appareil déclenchent
              l&apos;alerte à l&apos;heure.
            </p>
            <p className="flex items-start gap-1.5">
              <Info size={13} className="text-teal-500 flex-shrink-0 mt-0.5" />
              Téléphone sans aucun réseau et application fermée : le rappel arrivera dès le retour du réseau.
            </p>
            <p className="flex items-start gap-1.5">
              <Info size={13} className="text-teal-500 flex-shrink-0 mt-0.5" />
              Sur iPhone et iPad : notifications seulement si l&apos;application est installée sur l&apos;écran
              d&apos;accueil (iOS 16.4 ou plus récent).
            </p>
            {!online && (
              <p className="flex items-start gap-1.5 text-amber-700">
                <CheckCircle2 size={13} className="flex-shrink-0 mt-0.5" />
                Hors ligne : ces réglages demandent une connexion.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
