import { createContext, useContext, useEffect, useState, useCallback } from "react";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        setUser(await res.json());
      } else {
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  // Renouvelle l'access token (15 min) toutes les 10 minutes, tant qu'une
  // session est active, pour garder l'utilisateur connecté sans qu'il s'en
  // rende compte (le refresh token, lui, dure 30 jours).
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      fetch("/api/auth/refresh", { method: "POST" }).catch(() => {});
    }, 10 * 60 * 1000);
    return () => clearInterval(interval);
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
    setUser(data);
    return data;
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
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