import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { SESSION_EXPIRED_EVENT, isSessionStale, markSessionFresh, refreshSession } from "../lib/session";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    try {
      // L'intercepteur global est désactivé ici : en cas de 401 (access
      // token expiré pendant une veille), on tente explicitement un
      // renouvellement puis on réessaie avant de conclure « déconnecté ».
      let res = await fetch("/api/auth/me", { skipAuthRefresh: true });
      if (res.status === 401 && (await refreshSession()) === "ok") {
        res = await fetch("/api/auth/me", { skipAuthRefresh: true });
      }
      if (res.ok) {
        setUser(await res.json());
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  // Session impossible à renouveler (signalée par l'intercepteur fetch) :
  // l'utilisateur repasse en « déconnecté » et sera renvoyé vers la connexion.
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  // Renouvelle l'access token (15 min) toutes les 10 minutes, tant qu'une
  // session est active, pour garder l'utilisateur connecté sans qu'il s'en
  // rende compte (le refresh token, lui, dure 30 jours).
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      refreshSession();
    }, 10 * 60 * 1000);
    // Après une mise en veille ou une coupure réseau, les minuteries ont pu
    // être suspendues : on renouvelle dès le retour sur l'onglet ou le retour
    // de la connexion si le dernier renouvellement date de plus de 10 min.
    const refreshIfStale = () => {
      if (document.visibilityState === "visible" && isSessionStale()) refreshSession();
    };
    document.addEventListener("visibilitychange", refreshIfStale);
    window.addEventListener("online", refreshIfStale);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfStale);
      window.removeEventListener("online", refreshIfStale);
    };
  }, [user]);

  const login = async (email, password) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Échec de la connexion");
    }
    const data = await res.json();
    markSessionFresh();
    setUser(data);
    return data;
  };

  const register = async (name, email, password) => {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Échec de l'inscription");
    }
    // Le compte n'est pas connecté à cette étape : il reste à vérifier
    // l'adresse courriel avant de pouvoir accéder à quoi que ce soit (§6.1).
    return await res.json();
  };

  const resendVerification = async (email) => {
    const res = await fetch("/api/auth/resend-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Échec de l'envoi");
    }
    return await res.json();
  };

  const verifyEmail = async (token) => {
    const res = await fetch(`/api/auth/verify-email/${token}`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Lien de vérification invalide");
    }
    const data = await res.json();
    markSessionFresh();
    setUser(data);
    return data;
  };

  // La session locale est fermée même si l'appel réseau échoue (hors ligne,
  // serveur indisponible).
  const logout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignoré : l'interface repasse « déconnectée » quoi qu'il arrive
    } finally {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, login, register, logout, resendVerification, verifyEmail, refreshUser: loadMe }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
