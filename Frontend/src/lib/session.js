// Maintien de la session : l'access token (cookie, 15 min) est renouvelé
// par POST /api/auth/refresh (cookie refresh_token, 30 jours). Après une
// mise en veille, l'onglet peut se réveiller avec un access token expiré :
// plutôt que de modifier chaque appel `fetch` de l'application, un
// intercepteur global rejoue automatiquement la requête après un
// renouvellement réussi.

// Événement émis quand la session ne peut plus être renouvelée : le contexte
// d'authentification l'écoute pour repasser l'utilisateur en « déconnecté ».
export const SESSION_EXPIRED_EVENT = "sunusante:session-expired";

// Au-delà de ce délai depuis le dernier renouvellement, l'access token est
// considéré comme possiblement expiré (il dure 15 min).
export const SESSION_STALE_MS = 10 * 60 * 1000;

const nativeFetch = typeof window !== "undefined" ? window.fetch.bind(window) : null;

let refreshPromise = null;
let lastRefreshAt = 0;

// À appeler quand le serveur vient de poser de nouveaux cookies de session
// (connexion, vérification d'adresse, renouvellement).
export function markSessionFresh() {
  lastRefreshAt = Date.now();
}

export function isSessionStale() {
  return Date.now() - lastRefreshAt > SESSION_STALE_MS;
}

function signalSessionExpired() {
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

// Renouvelle la session. Les appels simultanés partagent la même promesse :
// le serveur fait tourner le refresh token à chaque appel, deux
// renouvellements parallèles se gêneraient.
// Résout "ok" | "expired" (le serveur refuse : session terminée) | "network".
export function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = nativeFetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" })
      .then((res) => {
        if (res.ok) {
          markSessionFresh();
          return "ok";
        }
        // 401/403 : refresh token absent, expiré ou révoqué
        if (res.status === 401 || res.status === 403) {
          signalSessionExpired();
          return "expired";
        }
        return "network";
      })
      .catch(() => "network")
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

// Requêtes concernées par le renouvellement automatique : API et fichiers
// privés du même domaine, hors routes qui n'ont pas de sens à rejouer.
const EXCLUDED_PREFIXES = ["/api/auth/refresh", "/api/auth/login", "/api/auth/logout", "/api/public/"];

function shouldIntercept(url) {
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin !== window.location.origin) return false;
    if (!u.pathname.startsWith("/api/") && !u.pathname.startsWith("/uploads/")) return false;
    return !EXCLUDED_PREFIXES.some((p) => u.pathname.startsWith(p));
  } catch {
    return false;
  }
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? "";
}

let installed = false;

// Remplace window.fetch par une version qui, sur une réponse 401, renouvelle
// la session une fois puis rejoue la requête d'origine.
// Option propre à l'application : `{ skipAuthRefresh: true }` désactive ce
// comportement pour un appel donné.
export function installFetchInterceptor() {
  if (installed || !nativeFetch) return;
  installed = true;

  window.fetch = async (input, init) => {
    if (init?.skipAuthRefresh || !shouldIntercept(requestUrl(input))) {
      return nativeFetch(input, init);
    }

    // La requête est construite puis clonée AVANT l'envoi : un corps
    // FormData (téléversement) ou un flux ne peut être lu qu'une fois.
    let request;
    let retry;
    try {
      request = new Request(input, init);
      retry = request.clone();
    } catch {
      return nativeFetch(input, init);
    }

    const res = await nativeFetch(request);
    if (res.status !== 401) return res;

    const outcome = await refreshSession();
    if (outcome !== "ok") return res;
    return nativeFetch(retry);
  };
}

// Avant d'ouvrir un lien privé (/uploads, export…) dans un nouvel onglet ou
// en téléchargement : le navigateur ne passe pas par l'intercepteur, il faut
// donc s'assurer que l'access token est encore valide. Appel léger à
// /api/auth/me, qui déclenche le renouvellement si besoin.
export async function ensureFreshSession() {
  if (!isSessionStale()) return;
  try {
    const res = await window.fetch("/api/auth/me");
    // /me a répondu sans renouvellement : le token est valide, mais son âge
    // est inconnu → on renouvelle par précaution pour couvrir l'ouverture.
    if (res.ok && isSessionStale()) await refreshSession();
  } catch {
    // Hors ligne : on laisse le navigateur tenter l'ouverture.
  }
}

// Gestionnaire onClick pour un lien <a href> vers une ressource privée.
// Si la session est récente, le lien s'ouvre normalement. Sinon, l'ouverture
// est différée le temps du renouvellement (l'onglet est ouvert tout de suite
// pour ne pas être bloqué comme fenêtre surgissante).
export function openPrivateLink(event) {
  if (!isSessionStale()) return;
  if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const a = event.currentTarget;
  const href = a.href;
  const download = a.hasAttribute("download") ? a.getAttribute("download") : null;
  const newTab = a.target === "_blank";
  event.preventDefault();

  if (download !== null) {
    ensureFreshSession().then(() => {
      const link = document.createElement("a");
      link.href = href;
      link.download = download;
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
    return;
  }

  const win = newTab ? window.open("", "_blank") : null;
  ensureFreshSession().then(() => {
    if (win) {
      win.opener = null;
      win.location.href = href;
    } else if (newTab) {
      window.open(href, "_blank", "noopener");
    } else {
      window.location.href = href;
    }
  });
}
