/* eslint-env serviceworker */
// ── Service worker de SunuSanté Famille (application installable) ──────────
// Écrit à la main (sans bibliothèque) : chaque règle de cache est visible ici.
// Le build (pwa/vitePlugin.js) le publie en /sw.js en y injectant la version
// et la liste des fichiers de l'interface à garder (« précache »).
//
// 1. Interface : HTML, JS, CSS, icônes gardés à l'installation → l'application
//    s'ouvre sans réseau.
// 2. Données (cahier des charges §10) : les réponses de LECTURE de l'API déjà
//    consultées (liste API_LECTURE) sont gardées, « réseau d'abord, cache en
//    secours ». Seulement les réponses 200 du compte connecté, dans un cache
//    à son nom ; effacé à la déconnexion, au changement de compte, à
//    l'expiration de la session, et après 7 jours sans connexion réussie.
//    JAMAIS : fichiers des documents (/uploads), exports, pages publiques,
//    routes d'authentification (hors /api/auth/me), requêtes autres que GET.
//    L'API répond « Cache-Control: no-store » : cela interdit le cache HTTP
//    du navigateur et des proxys, pas ce cache applicatif explicite, contrôlé
//    par l'application et effacé selon les règles ci-dessus (choix voulu).
// 3. Notifications push : affichage, boutons « Pris » / « Pas pris »,
//    ouverture de la bonne page au clic.

const BUILD = self.__SUNUSANTE_BUILD__ || { version: "dev", files: [] };

const SHELL_CACHE = `sunusante-interface-${BUILD.version}`;
const SHELL_PREFIX = "sunusante-interface-";
const DATA_PREFIX = "sunusante-donnees-u";
const META_CACHE = "sunusante-etat";
const META_KEY = "/__sunusante/etat";
const INDEX_URL = "/index.html";
// ignoreVary : les réponses portent « Vary: Accept-Encoding » (nginx) ou
// « Vary: Origin » (API) ; la copie gardée vaut quels que soient ces en-têtes.
const SHELL_MATCH = { cacheName: SHELL_CACHE, ignoreVary: true };

// Données gardées au plus 7 jours sans connexion réussie au serveur.
const MAX_OFFLINE_MS = 7 * 24 * 60 * 60 * 1000;

const NOT_CACHED_MESSAGE = "Cette page n'a pas encore été consultée sur cet appareil : connexion nécessaire";

// Réponses de lecture gardées pour la consultation hors ligne (chemin exact,
// paramètres compris : ?familyId=…, ?memberId=…).
const API_LECTURE = [
  /^\/api\/auth\/me$/,
  /^\/api\/account$/,
  /^\/api\/families$/,
  /^\/api\/family-memberships$/,
  /^\/api\/members$/,
  /^\/api\/members\/household$/,
  /^\/api\/appointments$/,
  /^\/api\/treatments$/,
  /^\/api\/vaccinations$/,
  /^\/api\/intakes$/,
  /^\/api\/dashboard$/,
  /^\/api\/dashboard\/family$/,
  /^\/api\/emergency\/\d+$/,
  /^\/api\/notifications$/,
  /^\/api\/notifications\/preferences$/,
  /^\/api\/documents$/, // la liste seulement, jamais les fichiers
  /^\/api\/document-roles$/,
  /^\/api\/role-transfers$/,
  /^\/api\/reminder-settings$/,
  /^\/api\/village$/,
  /^\/api\/activity$/,
];

const isApiRead = (path) => API_LECTURE.some((re) => re.test(path));

// ── État : compte propriétaire des données gardées, dernière synchro ────────
// Gardé dans Cache Storage (le service worker peut être arrêté à tout moment
// par le navigateur : sa mémoire ne survit pas).
let metaMemo = null;

async function readMeta() {
  if (metaMemo) return metaMemo;
  try {
    const res = await (await caches.open(META_CACHE)).match(META_KEY);
    metaMemo = res ? await res.json() : { userId: null, lastSyncAt: 0 };
  } catch {
    metaMemo = { userId: null, lastSyncAt: 0 };
  }
  return metaMemo;
}

async function writeMeta(meta) {
  metaMemo = meta;
  const cache = await caches.open(META_CACHE);
  await cache.put(META_KEY, new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
}

// Efface toutes les données gardées (tous comptes) et l'état.
async function purgeData() {
  metaMemo = { userId: null, lastSyncAt: 0 };
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith(DATA_PREFIX) || k === META_CACHE).map((k) => caches.delete(k)));
}

// Le compte connecté est (re)connu : données d'un autre compte effacées.
async function setSessionUser(userId) {
  const meta = await readMeta();
  if (meta.userId === userId) return;
  await purgeData();
  await writeMeta({ userId, lastSyncAt: Date.now() });
}

const dataCacheName = (userId) => `${DATA_PREFIX}${userId}`;

// ── Installation : interface gardée ─────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // cache: "reload" : jamais une copie HTTP périmée dans le précache
      await cache.addAll(BUILD.files.map((url) => new Request(url, { cache: "reload" })));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(SHELL_PREFIX) && k !== SHELL_CACHE).map((k) => caches.delete(k)));
      // Plus de 7 jours sans connexion réussie : données effacées.
      const meta = await readMeta();
      if (meta.userId && Date.now() - meta.lastSyncAt > MAX_OFFLINE_MS) await purgeData();
      await self.clients.claim();
    })()
  );
});

// ── Messages de l'application ───────────────────────────────────────────────
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "session" && Number.isInteger(data.userId)) {
    event.waitUntil(setSessionUser(data.userId));
  } else if (data.type === "purge") {
    // Déconnexion, session expirée, changement de compte
    event.waitUntil(purgeData());
  }
});

// ── Requêtes ────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // écritures : jamais interceptées
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Espace support (/admin) et son API (/api/admin) : jamais servis ni
  // gardés par le service worker — réseau seul, aucune copie hors ligne.
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/api/admin")) return;

  if (url.pathname.startsWith("/api/")) {
    // Connexion avec Google (configuration, nonce à usage unique) : réseau
    // seul, jamais gardée (règle explicite, en plus de la liste API_LECTURE).
    if (url.pathname === "/api/auth/config" || url.pathname.startsWith("/api/auth/google")) return;
    if (isApiRead(url.pathname)) event.respondWith(apiNetworkFirst(request, url));
    return; // autres routes de l'API : réseau seul, jamais gardées
  }
  if (url.pathname.startsWith("/uploads/")) return; // documents : jamais gardés

  // Navigation dans l'application (toutes les pages React) : index.html gardé.
  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(request));
    return;
  }
  // Fichiers de l'interface : copie gardée d'abord, réseau sinon.
  event.respondWith(caches.match(request, SHELL_MATCH).then((hit) => hit || fetch(request)));
});

// Page : réseau d'abord (nouvelle version de l'application au plus vite) ;
// sans réseau, l'index.html gardé — React Router affiche la bonne page.
async function navigationResponse(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(INDEX_URL, SHELL_MATCH);
    return cached || Response.error();
  }
}

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

// Réponse gardée, marquée pour l'application (bandeau « Hors ligne — données
// du … ») : x-sunusante-hors-ligne et date d'enregistrement.
async function cachedCopy(response) {
  const headers = new Headers(response.headers);
  headers.set("x-sunusante-hors-ligne", "cache");
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers });
}

async function apiNetworkFirst(request, url) {
  let response;
  try {
    response = await fetch(request);
  } catch {
    return offlineFallback(request);
  }
  // Seules les réponses 200 sont gardées (jamais une erreur, une 401…).
  if (response.status !== 200) return response;
  try {
    let meta = await readMeta();
    if (url.pathname === "/api/auth/me") {
      // Le compte de la session est connu ici, quoi qu'ait signalé la page.
      const me = await response.clone().json();
      if (Number.isInteger(me?.id)) {
        await setSessionUser(me.id);
        meta = await readMeta();
      }
    }
    if (meta.userId) {
      const headers = new Headers(response.headers);
      headers.set("x-sunusante-date", new Date().toISOString());
      const copy = new Response(await response.clone().blob(), { status: 200, headers });
      const cache = await caches.open(dataCacheName(meta.userId));
      await cache.put(request, copy);
      meta.lastSyncAt = Date.now();
      await writeMeta(meta);
    }
  } catch {
    // Stockage plein ou indisponible : la réponse est servie quand même.
  }
  return response;
}

async function offlineFallback(request) {
  const meta = await readMeta();
  if (meta.userId && Date.now() - meta.lastSyncAt > MAX_OFFLINE_MS) await purgeData();
  else if (meta.userId) {
    const cache = await caches.open(dataCacheName(meta.userId));
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return cachedCopy(hit);
  }
  return jsonResponse({ error: NOT_CACHED_MESSAGE, code: "OFFLINE_NOT_CACHED" }, 503, { "x-sunusante-hors-ligne": "non-consulte" });
}

// ── Notifications push ──────────────────────────────────────────────────────
const ICON = "/icons/icon-192.png";
const BADGE = "/icons/badge-96.png";

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload?.title) return;
  event.waitUntil(showPush(payload));
});

async function showPush(payload) {
  const isIntake = !!(payload.intakeId && payload.actionToken);
  // Déjà affichée (alerte locale de l'application ouverte, même « tag ») :
  // remplacée sans nouvelle sonnerie.
  const existing = payload.tag ? await self.registration.getNotifications({ tag: payload.tag }) : [];
  await self.registration.showNotification(payload.title, {
    body: payload.body || "",
    tag: payload.tag,
    renotify: existing.length === 0,
    icon: ICON,
    badge: BADGE,
    lang: "fr",
    timestamp: payload.timestamp || Date.now(),
    requireInteraction: payload.category === "medication_intake",
    data: { url: payload.url || "/dashboard", intakeId: payload.intakeId, actionToken: payload.actionToken, notificationId: payload.notificationId },
    actions: isIntake
      ? [
          { action: "taken", title: "Pris" },
          { action: "not_taken", title: "Pas pris" },
        ]
      : [],
  });
  // L'application ouverte ne rejoue pas l'alerte de la même prise.
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  windows.forEach((c) => c.postMessage({ type: "push-recu", tag: payload.tag, notificationId: payload.notificationId }));
}

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const data = notification.data || {};
  notification.close();
  if ((event.action === "taken" || event.action === "not_taken") && data.intakeId && data.actionToken) {
    event.waitUntil(answerIntake(data, event.action, notification.tag));
    return;
  }
  event.waitUntil(openApp(data.url || "/dashboard"));
});

// Bouton « Pris » / « Pas pris » : réponse enregistrée sans ouvrir
// l'application, grâce au jeton d'action de la notification (pas besoin de
// session). Échec (jeton expiré, pas de réseau…) : l'application s'ouvre.
async function answerIntake(data, status, tag) {
  try {
    const res = await fetch(`/api/intakes/${data.intakeId}/respond-with-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: data.actionToken, status }),
      credentials: "omit",
    });
    if (!res.ok) throw new Error(String(res.status));
    await self.registration.showNotification(status === "taken" ? "C'est noté : médicament pris" : "C'est noté : médicament pas pris", {
      tag,
      icon: ICON,
      badge: BADGE,
      lang: "fr",
      silent: true,
      data: { url: data.url || "/dashboard" },
    });
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    windows.forEach((c) => c.postMessage({ type: "prise-repondue", intakeId: data.intakeId }));
  } catch {
    await openApp(data.url || "/dashboard");
  }
}

// Ouvre l'application sur la page demandée (fenêtre existante si possible).
async function openApp(path) {
  const target = new URL(path, self.location.origin);
  if (target.origin !== self.location.origin) return;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find((c) => new URL(c.url).origin === self.location.origin);
  if (existing) {
    await existing.focus();
    existing.postMessage({ type: "naviguer", url: target.pathname + target.search });
    return;
  }
  await self.clients.openWindow(target.href);
}

// Abonnement renouvelé par le navigateur (Chrome le fait parfois juste
// après la création) : le nouveau est transmis au serveur et l'ancien
// retiré. Réussit si la session de l'appareil est encore valide ; sinon le
// service push répondra 410 pour l'ancien, que le serveur oubliera, et
// l'appareil sera réabonné depuis la page Notifications.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      let subscription = event.newSubscription;
      if (!subscription && old?.options) subscription = await self.registration.pushManager.subscribe(old.options);
      if (!subscription) return;
      const send = (method, body) =>
        fetch("/api/push/subscriptions", {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "same-origin",
        });
      await send("POST", subscription.toJSON());
      if (old?.endpoint && old.endpoint !== subscription.endpoint) await send("DELETE", { endpoint: old.endpoint });
    })().catch(() => {})
  );
});
