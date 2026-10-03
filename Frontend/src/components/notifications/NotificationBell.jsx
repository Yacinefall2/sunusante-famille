import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Bell, CheckCheck, Loader2, Settings } from "lucide-react";
import { NotificationItem } from "./NotificationItem";
import { useNotifications } from "./useNotifications";

// Cloche de la barre supérieure : compteur de notifications non lues
// (rafraîchi toutes les 60 s et à chaque changement de page) et panneau
// déroulant listant les dernières notifications.
export function NotificationBell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { items, unreadCount, loading, reload, markRead, markAllRead } = useNotifications({ pollMs: 60000 });
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  // Rechargement à chaque changement de page.
  useEffect(() => {
    reload();
    setOpen(false);
  }, [pathname, reload]);

  // Fermeture au clic extérieur et sur Échap.
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openNotification = (n) => {
    if (!n.readAt) markRead(n.id);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const badge = unreadCount > 9 ? "9+" : String(unreadCount);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Notifications"
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} non lues)` : "Notifications"}
        aria-expanded={open}
        className="relative p-2 rounded-xl hover:bg-gray-50 text-gray-500 transition-colors"
      >
        <Bell size={20} />
        {unreadCount > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed left-2 right-2 top-16 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96 bg-white rounded-2xl shadow-2xl border border-gray-100 z-50 overflow-hidden flex flex-col max-h-[75vh]">
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
            <h3 className="font-bold text-gray-800">Notifications</h3>
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="inline-flex items-center gap-1 text-xs font-semibold text-teal-600 hover:text-teal-700 disabled:text-gray-300 disabled:cursor-not-allowed"
            >
              <CheckCheck size={14} />
              Tout marquer comme lu
            </button>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
            {loading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="animate-spin text-teal-500" size={24} />
              </div>
            ) : items.length === 0 ? (
              <div className="text-center py-10 text-gray-400">
                <Bell size={28} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">Aucune notification</p>
              </div>
            ) : (
              items.map((n) => <NotificationItem key={n.id} notification={n} onOpen={openNotification} compact />)
            )}
          </div>

          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="flex items-center justify-center gap-1.5 px-4 py-3 border-t border-gray-100 text-sm font-semibold text-teal-600 hover:bg-teal-50 transition-colors"
          >
            <Settings size={14} />
            Préférences de notification
          </Link>
        </div>
      )}
    </div>
  );
}
