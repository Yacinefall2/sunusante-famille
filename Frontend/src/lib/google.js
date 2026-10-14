// « Continuer avec Google » (Google Identity Services, GIS).
// L'identifiant client est lu à l'exécution (GET /api/auth/config) : sans
// GOOGLE_CLIENT_ID côté serveur, null → aucun bouton Google, et changer
// l'identifiant ne demande pas de reconstruire l'application.
// Le script officiel de Google n'est chargé que si le bouton doit s'afficher
// (CSP : security-headers.conf autorise https://accounts.google.com/gsi/…).

const GIS_SRC = "https://accounts.google.com/gsi/client";

let configPromise = null;

// Identifiant client Google, ou null (fonction désactivée ou serveur injoignable).
export function loadGoogleClientId() {
  if (!configPromise) {
    configPromise = fetch("/api/auth/config", { skipAuthRefresh: true, offlineSilent: true })
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => (typeof data.googleClientId === "string" && data.googleClientId ? data.googleClientId : null))
      .catch(() => {
        // Hors ligne : on réessaiera au prochain affichage.
        configPromise = null;
        return null;
      });
  }
  return configPromise;
}

let scriptPromise = null;

export function loadGoogleScript() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => (window.google?.accounts?.id ? resolve(window.google) : reject(new Error("GIS indisponible")));
      script.onerror = () => {
        scriptPromise = null;
        script.remove();
        reject(new Error("GIS indisponible"));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

// Nonce à usage unique émis par le serveur, recopié par Google dans le jeton
// d'identité (protection contre le rejeu). Un nouveau à chaque tentative.
export async function fetchGoogleNonce() {
  const res = await fetch("/api/auth/google/nonce", { skipAuthRefresh: true });
  if (!res.ok) throw new Error("nonce");
  return (await res.json()).nonce;
}

// Appel JSON des routes Google. Hors session (connexion, inscription,
// invitation), pas de renouvellement automatique de session sur 401 ; il reste
// actif pour « Mon compte » (authRefresh).
export async function postGoogle(url, body, { authRefresh = false } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    skipAuthRefresh: !authRefresh,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
