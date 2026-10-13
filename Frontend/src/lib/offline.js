import { useSyncExternalStore } from "react";

// ── Fonctionnement hors ligne (cahier des charges §10, §11) ─────────────────
// Les données déjà consultées restent lisibles sans réseau (cache du service
// worker, public/sw.js — voir lib/pwa.js) ; toute écriture exige la
// connexion : l'intercepteur fetch (lib/session.js) refuse les requêtes qui
// modifient des données tant que l'application est hors ligne, et les
// boutons d'écriture se désactivent (useOnline, OFFLINE_HINT).
//
// État partagé : hors ligne ou non, date de la donnée affichée la plus
// ancienne (réponses servies par le cache), page jamais consultée.

export const OFFLINE_HINT = "Connexion nécessaire";
export const OFFLINE_WRITE_ERROR =
  "Connexion nécessaire : vous êtes hors ligne. Réessayez une fois la connexion revenue.";
export const NOT_CACHED_MESSAGE = "Cette page n'a pas encore été consultée sur cet appareil : connexion nécessaire";

// En-têtes posés par le service worker sur les réponses qu'il sert lui-même.
export const HEADER_OFFLINE = "x-sunusante-hors-ligne"; // "cache" | "non-consulte"
export const HEADER_CACHE_DATE = "x-sunusante-date"; // date d'enregistrement (ISO)

let state = {
  // Réseau indisponible : navigateur hors ligne, ou dernier appel à l'API
  // impossible (Wi-Fi sans Internet : navigator.onLine reste vrai).
  offline: typeof navigator !== "undefined" ? navigator.onLine === false : false,
  // Date de la plus ancienne donnée servie par le cache depuis la coupure
  oldestDataAt: null,
  // Au moins une donnée de la page actuelle n'a jamais été consultée
  missing: false,
};
const listeners = new Set();

function setState(patch) {
  const next = { ...state, ...patch };
  if (Object.keys(patch).every((k) => next[k] === state[k])) return;
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getOfflineState = () => state;
export const isOffline = () => state.offline;

export function useOfflineState() {
  return useSyncExternalStore(subscribe, getOfflineState, getOfflineState);
}

// Vrai si l'application a le réseau. Sert à désactiver les boutons d'écriture.
export function useOnline() {
  return !useOfflineState().offline;
}

// Retour du réseau : on oublie les dates des données en cache.
function markOnline() {
  setState({ offline: false, oldestDataAt: null, missing: false });
}

function markOffline() {
  setState({ offline: true });
}

// Changement de page : l'indication « page jamais consultée » repart de zéro.
export function resetPageOfflineState() {
  setState({ missing: false });
}

// Dernière réponse réussie du serveur (« données du … » quand aucune donnée
// n'a encore été servie par le cache). Écrite au plus une fois par minute.
const LAST_SYNC_KEY = "sunusante.derniereSynchro";
let lastSyncWrite = 0;

function recordSync() {
  const now = Date.now();
  if (now - lastSyncWrite < 60 * 1000) return;
  lastSyncWrite = now;
  try {
    localStorage.setItem(LAST_SYNC_KEY, new Date(now).toISOString());
  } catch {
    // stockage indisponible : le bandeau n'affichera pas de date
  }
}

export function lastSyncAt() {
  try {
    return localStorage.getItem(LAST_SYNC_KEY);
  } catch {
    return null;
  }
}

export function forgetLastSync() {
  lastSyncWrite = 0;
  try {
    localStorage.removeItem(LAST_SYNC_KEY);
  } catch {
    // rien à effacer
  }
}

// Appelé par l'intercepteur fetch pour chaque réponse de l'API.
export function noteApiResponse(res) {
  const source = res.headers.get(HEADER_OFFLINE);
  if (!source) {
    // Réponse du serveur : le réseau est là.
    if (state.offline) markOnline();
    if (res.ok) recordSync();
    return;
  }
  if (source === "ecriture") return;
  const patch = { offline: true };
  if (source === "non-consulte") patch.missing = true;
  const date = res.headers.get(HEADER_CACHE_DATE);
  if (date && (!state.oldestDataAt || date < state.oldestDataAt)) patch.oldestDataAt = date;
  setState(patch);
}

// Appel réseau impossible (TypeError de fetch) : hors ligne.
export function noteNetworkFailure() {
  markOffline();
}

// Réponse « refusée hors ligne », construite sans appeler le réseau.
export function offlineWriteResponse() {
  return new Response(JSON.stringify({ error: OFFLINE_WRITE_ERROR, code: "OFFLINE" }), {
    status: 503,
    headers: { "Content-Type": "application/json", [HEADER_OFFLINE]: "ecriture" },
  });
}

let installed = false;
export function installOnlineListeners() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("offline", markOffline);
  // « online » ne garantit pas que le serveur répond : la prochaine réponse
  // de l'API le confirmera. On retire tout de suite le bandeau, les écritures
  // échoueront avec un message clair si le réseau n'est pas vraiment revenu.
  window.addEventListener("online", markOnline);
}

// « 13/10 à 14:05 »
export function formatOfflineDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} à ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
