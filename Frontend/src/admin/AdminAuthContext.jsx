import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ADMIN_SESSION_EXPIRED, adminFetch } from "./api";

// Authentification de l'espace support : SÉPARÉE de celle des familles
// (AuthContext). Mot de passe + code à 6 chiffres ; session de 30 minutes
// côté serveur, et déconnexion automatique après 30 minutes d'inactivité.
const AdminAuthContext = createContext(null);

export const INACTIVITY_MS = 30 * 60 * 1000;
const ACTIVITY_EVENTS = ["mousedown", "keydown", "touchstart", "scroll"];

export function AdminAuthProvider({ children }) {
  const [supportUser, setSupportUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expiredMessage, setExpiredMessage] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    adminFetch("/api/admin/auth/me")
      .then(setSupportUser)
      .catch(() => setSupportUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onExpired = () => {
      setSupportUser((current) => {
        if (current) setExpiredMessage("Votre session a expiré. Reconnectez-vous.");
        return null;
      });
    };
    window.addEventListener(ADMIN_SESSION_EXPIRED, onExpired);
    return () => window.removeEventListener(ADMIN_SESSION_EXPIRED, onExpired);
  }, []);

  const login = async ({ email, password, code }) => {
    const data = await adminFetch("/api/admin/auth/login", { method: "POST", body: { email, password, code } });
    setExpiredMessage(null);
    setSupportUser(data);
    return data;
  };

  const logout = useCallback(async (message = null) => {
    try {
      await adminFetch("/api/admin/auth/logout", { method: "POST" });
    } catch {
      // session déjà fermée côté serveur : sans importance
    }
    setExpiredMessage(message);
    setSupportUser(null);
  }, []);

  // Déconnexion automatique après 30 minutes sans activité.
  useEffect(() => {
    if (!supportUser) return undefined;
    const reset = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => logout("Déconnexion automatique après 30 minutes d'inactivité."), INACTIVITY_MS);
    };
    reset();
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      clearTimeout(timer.current);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [supportUser, logout]);

  return (
    <AdminAuthContext.Provider value={{ supportUser, loading, login, logout, expiredMessage }}>{children}</AdminAuthContext.Provider>
  );
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error("useAdminAuth doit être utilisé dans AdminAuthProvider");
  return ctx;
}
