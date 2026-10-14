import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { SESSION_EXPIRED_EVENT, isSessionStale, markSessionFresh, refreshSession } from "../lib/session";
import { clearOfflineData, setOfflineSessionUser, unsubscribeThisDevice } from "../lib/pwa";
import { postGoogle } from "../lib/google";

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

  // Données gardées pour la consultation hors ligne : cloisonnées par compte.
  // Le service worker efface celles d'un autre compte. Si un autre compte
  // utilisait cet appareil sans s'être déconnecté, l'abonnement aux
  // notifications push du navigateur était le sien : il est retiré (le
  // serveur l'oubliera à son prochain envoi).
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    if (setOfflineSessionUser(userId)) unsubscribeThisDevice();
  }, [userId]);

  // Session impossible à renouveler (signalée par l'intercepteur fetch) :
  // l'utilisateur repasse en « déconnecté » et sera renvoyé vers la connexion.
  // Les données gardées hors ligne sont effacées. Les notifications push de
  // l'appareil restent actives (rappels de médicaments) jusqu'à une
  // déconnexion volontaire ou au retrait de l'appareil.
  useEffect(() => {
    const onExpired = () => {
      clearOfflineData();
      setUser(null);
    };
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
      // code : ACCOUNT_SUSPENDED (compte suspendu par le support, UC-52)
      throw Object.assign(new Error(err.error || "Échec de la connexion"), { code: err.code });
    }
    const data = await res.json();
    markSessionFresh();
    setUser(data);
    return data;
  };

  // « Continuer avec Google » : le jeton d'identité reçu du bouton Google est
  // envoyé tel quel ; c'est le serveur qui le vérifie. Renvoie soit le compte
  // connecté, soit { needsSignup, signupToken, name, email } (personne n'a
  // encore de compte : écran de confirmation, rien n'est créé).
  const googleSignIn = async (credential) => {
    const { ok, data } = await postGoogle("/api/auth/google", { credential });
    if (!ok) throw Object.assign(new Error(data.error || "Connexion avec Google impossible"), { code: data.code });
    if (data.needsSignup) return data;
    markSessionFresh();
    setUser(data);
    return data;
  };

  // Confirmation de l'inscription avec Google (conditions acceptées) : le
  // compte est créé, déjà vérifié, et la session ouverte.
  const googleSignup = async ({ signupToken, name }) => {
    const { ok, data } = await postGoogle("/api/auth/google/signup", { signupToken, name, accept: true });
    if (!ok) throw new Error(data.error || "Création du compte impossible");
    const { invitation: _invitation, ...account } = data;
    markSessionFresh();
    setUser(account);
    return data;
  };

  // « Accepter avec Google » une invitation. La session peut être ouverte
  // même si l'acceptation échoue (déjà membre d'un espace…) : data.user.
  const acceptInvitationWithGoogle = async (token, credential) => {
    const { ok, data } = await postGoogle(`/api/invitations/${token}/accept-google`, { credential });
    if (data.user) {
      markSessionFresh();
      setUser(data.user);
    }
    if (!ok) throw Object.assign(new Error(data.error || "Acceptation avec Google impossible"), { code: data.code });
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

  // Mode senior (UC-25) : réglage d'affichage du compte, sans effet sur les
  // droits. Classe `senior` sur <html> : grands caractères, contrastes et
  // zones tactiles agrandis (index.css).
  const seniorMode = !!user?.seniorMode;
  useEffect(() => {
    document.documentElement.classList.toggle("senior", seniorMode);
  }, [seniorMode]);

  // Active ou désactive le mode senior pour soi-même. Renvoie l'état final ;
  // lève une erreur (message prêt à afficher) en cas d'échec.
  const setSeniorMode = async (on) => {
    const res = await fetch("/api/account/display", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seniorMode: on }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Impossible de modifier l'affichage");
    setUser((u) => (u ? { ...u, seniorMode: !!data.seniorMode } : u));
    return !!data.seniorMode;
  };

  // La session locale est fermée même si l'appel réseau échoue (hors ligne,
  // serveur indisponible). Avant : désabonnement de CET appareil des
  // notifications push (la session est encore valide pour le dire au
  // serveur). Après : effacement des données gardées hors ligne.
  const logout = async () => {
    try {
      await unsubscribeThisDevice();
    } catch {
      // ignoré : le navigateur peut ne pas prendre en charge le push
    }
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignoré : l'interface repasse « déconnectée » quoi qu'il arrive
    } finally {
      await clearOfflineData();
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        googleSignIn,
        googleSignup,
        acceptInvitationWithGoogle,
        register,
        logout,
        resendVerification,
        verifyEmail,
        refreshUser: loadMe,
        seniorMode,
        setSeniorMode,
      }}
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
