import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { NOTIFICATIONS_REFRESH_EVENT, notifyNotificationsChanged } from "./intakes";

// Chargement des notifications de l'utilisateur connecté (50 dernières),
// avec rechargement périodique facultatif (`pollMs`) et synchronisation
// entre composants (cloche, page Notifications) via un événement global.
export function useNotifications({ pollMs = 0 } = {}) {
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const data = await res.json();
      setItems(Array.isArray(data?.items) ? data.items : []);
      setUnreadCount(Number(data?.unreadCount) || 0);
    } catch {
      // Silencieux : nouvelle tentative au prochain rafraîchissement.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    const onRefresh = () => reload();
    window.addEventListener(NOTIFICATIONS_REFRESH_EVENT, onRefresh);
    const timer = pollMs > 0 ? setInterval(reload, pollMs) : null;
    return () => {
      window.removeEventListener(NOTIFICATIONS_REFRESH_EVENT, onRefresh);
      if (timer) clearInterval(timer);
    };
  }, [reload, pollMs]);

  const markRead = useCallback(async (id) => {
    // Mise à jour optimiste, puis synchronisation avec le serveur.
    setItems((list) => list.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "POST" });
    } finally {
      notifyNotificationsChanged();
    }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/read-all", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Impossible de tout marquer comme lu");
      }
    } catch {
      toast.error("Impossible de tout marquer comme lu");
    } finally {
      notifyNotificationsChanged();
    }
  }, []);

  return { items, unreadCount, loading, reload, markRead, markAllRead };
}
