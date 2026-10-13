import { useSyncExternalStore } from "react";
import { forgetLastSync } from "./offline.js";

// ── Application installable : service worker, installation, push ──────────
// Le service worker (pwa/service-worker.js, publié en /sw.js au build) garde
// l'interface et les données déjà consultées, et affiche les notifications
// push. Il n'est pas enregistré en développement (npm run dev).

export const swSupported = () => typeof navigator !== "undefined" && "serviceWorker" in navigator;

// Événement interne : le service worker demande d'ouvrir une page (clic sur
// une notification alors que l'application est déjà ouverte).
export const SW_NAVIGATE_EVENT = "sunusante:naviguer";
// Un push vient d'être affiché (même prise : pas de seconde alerte locale).
export const SW_PUSH_EVENT = "sunusante:push-recu";

export function registerServiceWorker() {
  if (!swSupported() || !import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
      console.warn("Service worker non enregistré :", error);
    });
  });
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type === "naviguer" && typeof data.url === "string") {
      window.dispatchEvent(new CustomEvent(SW_NAVIGATE_EVENT, { detail: data.url }));
    } else if (data.type === "push-recu") {
      window.dispatchEvent(new CustomEvent(SW_PUSH_EVENT, { detail: data }));
    } else if (data.type === "prise-repondue") {
      // Réponse donnée depuis la notification : cloche et accueil à jour
      window.dispatchEvent(new Event("notifications:refresh"));
    }
  });
}

// Message au service worker actif (s'il y en a un).
function postToServiceWorker(message) {
  if (!swSupported()) return;
  navigator.serviceWorker.controller?.postMessage(message);
  navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage(message)).catch(() => {});
}

// ── Données hors ligne : cloisonnées par compte ────────────────────────────
const LAST_USER_KEY = "sunusante.dernierCompte";
const DATA_PREFIX = "sunusante-donnees-u";

// Compte connecté connu : le service worker ne garde que SES données (celles
// d'un autre compte sont effacées). Renvoie true si le compte a changé sur
// cet appareil depuis la dernière fois.
export function setOfflineSessionUser(userId) {
  postToServiceWorker({ type: "session", userId });
  let previous = null;
  try {
    previous = Number(localStorage.getItem(LAST_USER_KEY)) || null;
    localStorage.setItem(LAST_USER_KEY, String(userId));
  } catch {
    // stockage indisponible
  }
  return previous !== null && previous !== userId;
}

// Efface les données gardées pour la consultation hors ligne (déconnexion,
// session expirée, changement de compte). Effacement fait aussi depuis la
// page : il ne dépend pas d'un service worker actif.
export async function clearOfflineData() {
  postToServiceWorker({ type: "purge" });
  forgetLastSync();
  // LAST_USER_KEY est gardé : il permet de reconnaître, à la prochaine
  // connexion, un changement de compte sur cet appareil.
  if (typeof caches === "undefined") return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(DATA_PREFIX) || k === "sunusante-etat").map((k) => caches.delete(k)));
  } catch {
    // stockage indisponible
  }
}

// ── Installation de l'application (bouton « Installer l'application ») ──────
let deferredPrompt = null;
let installed = false;
const installListeners = new Set();
const notifyInstall = () => installListeners.forEach((l) => l());

const isStandalone = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true);

// iPhone / iPad : pas d'événement d'installation, ajout manuel par Safari.
export const isIos = () =>
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

// À appeler au démarrage, avant le rendu : Chrome peut émettre l'événement
// très tôt.
export function captureInstallPrompt() {
  if (typeof window === "undefined") return;
  installed = isStandalone();
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // pas de bandeau automatique : bouton dans le menu
    deferredPrompt = event;
    notifyInstall();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installed = true;
    notifyInstall();
  });
}

function installSnapshot() {
  if (installed || isStandalone()) return "installed";
  if (deferredPrompt) return "available";
  if (isIos()) return "ios";
  return "unavailable";
}

// "installed" | "available" (bouton actif) | "ios" (instructions) | "unavailable"
export function useInstallState() {
  return useSyncExternalStore(
    (l) => {
      installListeners.add(l);
      return () => installListeners.delete(l);
    },
    installSnapshot,
    installSnapshot
  );
}

// Ouvre la fenêtre d'installation du navigateur. Renvoie true si acceptée.
export async function promptInstall() {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  notifyInstall();
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome === "accepted";
}

// ── Notifications push de cet appareil ──────────────────────────────────────
export const pushSupported = () =>
  swSupported() && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;

const urlBase64ToUint8Array = (base64) => {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

async function registration() {
  if (!swSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? navigator.serviceWorker.ready : null;
}

// Abonnement push du navigateur (null si aucun).
export async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Erreur");
  return data;
}

// « Recevoir les rappels sur cet appareil » : autorisation (au clic), puis
// abonnement auprès du service push du navigateur et enregistrement au serveur.
export async function subscribeThisDevice({ hideDetails = false } = {}) {
  if (!pushSupported()) throw new Error("Ce navigateur ne peut pas recevoir de notifications");
  const reg = await registration();
  if (!reg) throw new Error("Application pas encore prête : rechargez la page puis réessayez");
  const { enabled, publicKey } = await apiJson("/api/push/public-key");
  if (!enabled) throw new Error("Les notifications push ne sont pas activées sur ce serveur");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications refusées : autorisez-les dans les réglages du site de votre navigateur");
  }
  let subscription = await reg.pushManager.getSubscription();
  // Abonnement fait avec une autre clé serveur : on le refait.
  const key = subscription?.options?.applicationServerKey;
  if (subscription && key) {
    const current = new Uint8Array(key);
    const expected = urlBase64ToUint8Array(publicKey);
    if (current.length !== expected.length || current.some((b, i) => b !== expected[i])) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }
  if (!subscription) {
    try {
      subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    } catch {
      // Navigation privée (Chrome n'y permet pas le push), service push du
      // navigateur injoignable…
      throw new Error(
        "Le navigateur n'a pas pu abonner cet appareil (navigation privée, ou service de notification injoignable) : réessayez plus tard"
      );
    }
  }
  return apiJson("/api/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({ ...subscription.toJSON(), hideDetails }),
  });
}

// Désabonne CET appareil : au serveur (si la session le permet) puis auprès
// du navigateur — le service push répondra alors 410 et le serveur oubliera
// l'abonnement de lui-même si l'appel au serveur n'a pas pu se faire.
export async function unsubscribeThisDevice() {
  const subscription = await currentPushSubscription().catch(() => null);
  if (!subscription) return;
  try {
    await fetch("/api/push/subscriptions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
  } catch {
    // hors ligne : le désabonnement du navigateur suffit
  }
  try {
    await subscription.unsubscribe();
  } catch {
    // déjà désabonné
  }
}

// Notification affichée par le service worker (seule méthode qui marche sur
// Android ; « new Notification » en secours sur ordinateur).
export async function showLocalNotification(title, { body = "", tag, url = "/dashboard", requireInteraction = false } = {}) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  try {
    const reg = await registration();
    if (reg) {
      await reg.showNotification(title, {
        body,
        tag,
        renotify: true,
        requireInteraction,
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        lang: "fr",
        data: { url },
      });
      return true;
    }
    const n = new Notification(title, { body, tag, renotify: true, requireInteraction });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
