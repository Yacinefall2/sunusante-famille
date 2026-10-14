// Appels de l'API du support (/api/admin). Session propre (cookie
// admin_token, limité à /api/admin), sans renouvellement automatique : une
// réponse 401 signale la fin de session, l'espace repasse à l'écran de
// connexion (AdminAuthContext écoute ADMIN_SESSION_EXPIRED).
export const ADMIN_SESSION_EXPIRED = "sunusante:admin-session-expired";

export async function adminFetch(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith("/api/admin/auth/login")) {
    window.dispatchEvent(new CustomEvent(ADMIN_SESSION_EXPIRED));
  }
  if (!res.ok) throw Object.assign(new Error(data.error || "Erreur"), { status: res.status });
  return data;
}

export const TYPE_LABELS = {
  recovery: "Récupération de compte",
  data_deletion: "Suppression des données",
  report: "Signalement",
  other: "Autre question",
};

export const STATUS_LABELS = {
  unverified: "Non vérifiée",
  open: "Ouverte",
  in_progress: "En cours",
  resolved: "Traitée",
  rejected: "Refusée",
};

export const STATUS_VARIANTS = {
  unverified: "warning",
  open: "info",
  in_progress: "info",
  resolved: "success",
  rejected: "default",
};

export const CATEGORY_LABELS = {
  auth: "Connexion",
  http_error: "Erreur serveur",
  email: "Courriel",
  worker: "Worker",
  push: "Push",
  security: "Sécurité",
  support: "Support",
};

export const LEVEL_VARIANTS = { info: "default", warn: "warning", error: "danger" };
