// ── Alertes sonores du mode senior (UC-25, M10 Accessibilité) ────────────────
// Son généré par le navigateur (Web Audio API — aucun fichier externe) et
// notification du navigateur (Notification API). Fonctionne quand
// SunuSanté Famille est OUVERTE ; l'application fermée relèvera des
// notifications « push » (lot PWA).
//
// Les navigateurs bloquent tout son tant que la personne n'a pas touché la
// page : le bouton « Activer les alertes sonores » débloque l'audio (et
// demande, une seule fois, l'autorisation d'afficher des notifications). Après
// un rechargement, le premier appui n'importe où sur la page le redébloque.

const ENABLED_KEY = "sunusante.alertesSonores";

let audioContext = null;

function getAudioContext() {
  if (audioContext) return audioContext;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioContext = new Ctx();
  return audioContext;
}

export const audioSupported = () => typeof window !== "undefined" && !!(window.AudioContext || window.webkitAudioContext);
export const notificationsSupported = () => typeof window !== "undefined" && "Notification" in window;

// Alertes activées sur cet appareil (choix mémorisé dans le navigateur).
export function alertsEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberEnabled() {
  try {
    localStorage.setItem(ENABLED_KEY, "1");
  } catch {
    // stockage indisponible (navigation privée) : réglage gardé le temps de la page
  }
}

// Débloque l'audio — à appeler DEPUIS un geste de la personne (clic, appui).
export async function unlockAudio() {
  const ctx = getAudioContext();
  if (!ctx) return false;
  try {
    if (ctx.state !== "running") await ctx.resume();
    return ctx.state === "running";
  } catch {
    return false;
  }
}

// Après un rechargement : le premier appui sur la page redébloque l'audio,
// si les alertes avaient été activées sur cet appareil.
let gestureListenerInstalled = false;
export function installAudioUnlockOnGesture() {
  if (gestureListenerInstalled || typeof document === "undefined") return;
  gestureListenerInstalled = true;
  const onGesture = () => {
    if (!alertsEnabled()) return;
    unlockAudio().then((ok) => {
      if (ok) {
        document.removeEventListener("pointerdown", onGesture, true);
        document.removeEventListener("keydown", onGesture, true);
      }
    });
  };
  document.addEventListener("pointerdown", onGesture, true);
  document.addEventListener("keydown", onGesture, true);
}

// Un bip doux (attaque et extinction progressives) mais fort.
function beep(ctx, start, frequency, duration = 0.22, volume = 0.6) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.03);
  gain.gain.setValueAtTime(volume, start + duration - 0.06);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

// Signal d'alerte : 3 bips montants, répétés 2 fois. Renvoie false si le son
// n'a pas pu être joué (audio encore bloqué par le navigateur).
export async function playAlertSound() {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state !== "running") {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  if (ctx.state !== "running") return false;
  const t0 = ctx.currentTime + 0.05;
  const notes = [660, 880, 1046]; // mi, la, do : distinct des sons du téléphone
  for (let r = 0; r < 2; r++) {
    notes.forEach((f, i) => beep(ctx, t0 + r * 1.4 + i * 0.32, f));
  }
  return true;
}

// Bouton « Activer les alertes sonores » : débloque l'audio, joue le signal
// pour que la personne l'entende une première fois, et demande (une seule
// fois) l'autorisation d'afficher des notifications.
export async function enableAlerts() {
  const audioOk = await unlockAudio();
  if (audioOk) await playAlertSound();
  rememberEnabled();
  let permission = notificationsSupported() ? Notification.permission : "unsupported";
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      // anciens navigateurs : pas de notification, le son et la grande alerte restent
    }
  }
  return { audioOk, permission };
}

export function notificationPermission() {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

// Notification du navigateur (visible même si l'onglet est en arrière-plan).
export function showBrowserNotification({ id, title, body }) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, tag: `sunusante-${id}`, renotify: true, requireInteraction: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Certains navigateurs mobiles n'autorisent les notifications que via un
    // service worker (lot PWA) : la grande alerte à l'écran suffit ici.
  }
}

// ── Notifications déjà alertées : jamais deux fois la même ───────────────────
const ALERTED_KEY = "sunusante.alertesJouees";
const OPENED_KEY = "sunusante.ouvertureSession";
const alerted = new Set(
  (() => {
    try {
      return JSON.parse(sessionStorage.getItem(ALERTED_KEY) || "[]");
    } catch {
      return [];
    }
  })()
);

export const wasAlerted = (id) => alerted.has(id);

export function markAlerted(id) {
  alerted.add(id);
  try {
    sessionStorage.setItem(ALERTED_KEY, JSON.stringify([...alerted].slice(-200)));
  } catch {
    // mémoire de la page seulement
  }
}

// Heure d'ouverture de l'application dans cet onglet (gardée au rechargement).
export function sessionOpenedAt() {
  try {
    const stored = Number(sessionStorage.getItem(OPENED_KEY));
    if (stored) return stored;
    const now = Date.now();
    sessionStorage.setItem(OPENED_KEY, String(now));
    return now;
  } catch {
    return (sessionOpenedAt.fallback ??= Date.now());
  }
}

export const ALERT_CATEGORIES = ["medication_intake", "appointment_reminder"];
const RECENT_UNREAD_MS = 15 * 60 * 1000;

// Une notification mérite-t-elle une alerte ? Rappel de prise (encore en
// attente) ou de rendez-vous, pas encore alerté, et créé après l'ouverture de
// l'application — ou non lu et de moins de 15 minutes. Jamais les anciennes.
export function shouldAlert(n, openedAt, now = Date.now()) {
  if (!ALERT_CATEGORIES.includes(n.category) || wasAlerted(n.id)) return false;
  if (n.category === "medication_intake" && n.intakeId && n.intakeStatus !== "pending") return false;
  const created = new Date(n.createdAt).getTime();
  if (Number.isNaN(created)) return false;
  return created >= openedAt || (!n.readAt && now - created < RECENT_UNREAD_MS);
}
