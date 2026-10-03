import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, CheckCheck, Info, Loader2, Mail, Monitor, Settings } from "lucide-react";
import toast from "react-hot-toast";
import { AppShell } from "../components/layout/AppShell";
import { NotificationItem } from "../components/notifications/NotificationItem";
import { useNotifications } from "../components/notifications/useNotifications";

// Case à cocher d'une préférence (canal "Dans l'application" ou "Par courriel").
function PreferenceCheckbox({ checked, disabled, onChange, label }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded text-teal-600 focus:ring-teal-500 disabled:opacity-50"
      />
      {/* Libellé visible uniquement sur mobile : les en-têtes de colonnes
          le portent sur écran large. */}
      <span className="text-sm text-gray-600 sm:sr-only">{label}</span>
    </label>
  );
}

export default function NotificationsPage() {
  const navigate = useNavigate();
  const { items, unreadCount, loading, markRead, markAllRead } = useNotifications();
  const [prefs, setPrefs] = useState([]);
  const [prefsLoading, setPrefsLoading] = useState(true);
  const [savingCategory, setSavingCategory] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/notifications/preferences");
        if (res.ok) {
          const data = await res.json();
          setPrefs(Array.isArray(data) ? data : []);
        } else {
          toast.error("Impossible de charger vos préférences");
        }
      } catch {
        toast.error("Impossible de charger vos préférences");
      } finally {
        setPrefsLoading(false);
      }
    })();
  }, []);

  // Enregistrement immédiat d'une préférence modifiée.
  const updatePref = async (pref, key, value) => {
    const next = { category: pref.category, inApp: pref.inApp, email: pref.email, [key]: value };
    const previous = prefs;
    setPrefs((list) => list.map((p) => (p.category === pref.category ? { ...p, [key]: value } : p)));
    setSavingCategory(pref.category);
    try {
      const res = await fetch("/api/notifications/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Erreur lors de l'enregistrement");
      }
      const data = await res.json();
      if (Array.isArray(data)) setPrefs(data);
      toast.success("Préférence enregistrée");
    } catch (e) {
      setPrefs(previous);
      toast.error(e.message || "Erreur lors de l'enregistrement");
    } finally {
      setSavingCategory(null);
    }
  };

  const openNotification = (n) => {
    if (!n.readAt) markRead(n.id);
    if (n.link) navigate(n.link);
  };

  return (
    <AppShell>
      <div className="space-y-6 max-w-3xl">
        {/* Préférences */}
        <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <h2 className="font-bold text-gray-800 flex items-center gap-2 mb-1">
            <Settings size={18} className="text-teal-600" /> Mes préférences
          </h2>
          <p className="text-sm text-gray-500 mb-4">Choisissez, pour chaque type de rappel, comment vous souhaitez être prévenu.</p>

          {prefsLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="animate-spin text-teal-500" size={24} />
            </div>
          ) : prefs.length === 0 ? (
            <p className="text-sm text-gray-400 italic">Aucune préférence disponible.</p>
          ) : (
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="hidden sm:grid grid-cols-[1fr_auto_auto] gap-6 bg-gray-50 px-4 py-2 text-xs font-bold text-gray-500 uppercase tracking-wide">
                <span>Type de rappel</span>
                <span className="w-36 flex items-center gap-1.5">
                  <Monitor size={12} /> Dans l&apos;application
                </span>
                <span className="w-28 flex items-center gap-1.5">
                  <Mail size={12} /> Par courriel
                </span>
              </div>
              {prefs.map((p, i) => (
                <div
                  key={p.category}
                  className={`grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2 sm:gap-6 px-4 py-3 items-center ${i > 0 ? "border-t border-gray-100" : ""}`}
                >
                  <div>
                    <p className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                      {p.label}
                      {savingCategory === p.category && <Loader2 size={12} className="animate-spin text-teal-500" />}
                    </p>
                    {p.category === "medication_intake" && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        Courriel désactivé par défaut : ces rappels peuvent être envoyés plusieurs fois par jour.
                      </p>
                    )}
                  </div>
                  <div className="flex gap-6 sm:contents">
                    <div className="sm:w-36">
                      <PreferenceCheckbox
                        label="Dans l'application"
                        checked={!!p.inApp}
                        disabled={savingCategory === p.category}
                        onChange={(v) => updatePref(p, "inApp", v)}
                      />
                    </div>
                    <div className="sm:w-28">
                      <PreferenceCheckbox
                        label="Par courriel"
                        checked={!!p.email}
                        disabled={savingCategory === p.category}
                        onChange={(v) => updatePref(p, "email", v)}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-gray-500 mt-4 flex items-start gap-1.5">
            <Info size={13} className="text-teal-500 flex-shrink-0 mt-0.5" />
            Les échecs d&apos;envoi de courriel vous sont toujours signalés dans l&apos;application.
          </p>
        </section>

        {/* Historique */}
        <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <h2 className="font-bold text-gray-800 flex items-center gap-2">
              <Bell size={18} className="text-teal-600" /> Historique
            </h2>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="inline-flex items-center gap-1 text-xs font-semibold text-teal-600 hover:text-teal-700"
              >
                <CheckCheck size={14} />
                Tout marquer comme lu
              </button>
            )}
          </div>

          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="animate-spin text-teal-500" size={24} />
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-10 text-gray-400">
              <Bell size={32} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">Aucune notification</p>
            </div>
          ) : (
            <div className="space-y-1">
              {items.map((n) => (
                <NotificationItem key={n.id} notification={n} onOpen={openNotification} />
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
