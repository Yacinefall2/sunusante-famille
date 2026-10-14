import net from "node:net";
import { lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { technicalLogs } from "../db/schema.js";

// ── Journaux techniques (UC-53, consultés par le support) ────────────────────
// Point unique d'écriture. Règle absolue : AUCUNE donnée médicale et AUCUN
// corps de requête ni de réponse. Seulement des métadonnées : route (sans
// paramètres de requête ni jetons), méthode, statut, durée, identifiant de
// compte, adresse IP tronquée, navigateur en clair court, destinataire masqué.

export const LEVELS = ["info", "warn", "error"];
export const CATEGORIES = ["auth", "http_error", "email", "worker", "push", "security", "support"];
export const RETENTION_DAYS = 90;

// Clés de métadonnées acceptées : toute autre clé est ignorée, pour qu'un
// appel maladroit ne puisse pas y glisser un contenu (corps, titre…).
const ALLOWED_KEYS = new Set([
  "route",
  "method",
  "status",
  "durationMs",
  "userId",
  "supportUserId",
  "ip",
  "userAgent",
  "to",
  "errorName",
  "errorCode",
  "reminders",
  "errors",
  "limiter",
  "statusCode",
  "lifted",
  "purged",
]);

// IPv4 : /24 (dernier octet à 0) ; IPv6 : /48 (trois premiers groupes).
export function truncateIp(ip) {
  if (!ip || typeof ip !== "string") return null;
  let value = ip.trim();
  if (value.startsWith("::ffff:") && net.isIPv4(value.slice(7))) value = value.slice(7);
  if (net.isIPv4(value)) return `${value.split(".").slice(0, 3).join(".")}.0/24`;
  if (net.isIPv6(value)) {
    // Développe « :: » pour garder exactement les trois premiers groupes.
    const [head, tail = ""] = value.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const groups = value.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
    return `${groups.slice(0, 3).map((g) => g || "0").join(":")}::/48`;
  }
  return null;
}

// « yacine@gmail.com » → « y***@gmail.com »
export function maskEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) return null;
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

// Navigateur et système en quelques mots (« Chrome sur Android »).
export function shortUserAgent(ua) {
  if (!ua || typeof ua !== "string") return null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : /curl|wget|node|axios|supertest|python/i.test(ua)
            ? "Outil"
            : "Autre";
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  return os ? `${browser} sur ${os}` : browser;
}

// Route SANS paramètres de requête ni valeurs : le motif Express quand il est
// connu (« /api/auth/verify-email/:token »), sinon le chemin dont les
// segments qui ressemblent à un identifiant ou à un jeton sont remplacés.
export function routeOf(req) {
  if (req.route?.path && typeof req.route.path === "string") return `${req.baseUrl ?? ""}${req.route.path}`.slice(0, 200);
  const path = String(req.originalUrl ?? req.url ?? "").split("?")[0];
  return path
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) ? ":id" : segment.length > 24 || /[^A-Za-z0-9._-]/.test(segment) ? ":valeur" : segment))
    .join("/")
    .slice(0, 200);
}

// Métadonnées communes d'une requête HTTP.
export function requestMeta(req) {
  return {
    route: routeOf(req),
    method: req.method,
    ip: truncateIp(req.ip),
    userAgent: shortUserAgent(req.get?.("user-agent")),
  };
}

function cleanMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!ALLOWED_KEYS.has(key) || value === undefined || value === null) continue;
    if (key === "ip") out.ip = truncateIp(value) ?? (String(value).includes("/") ? String(value).slice(0, 64) : null);
    else if (typeof value === "string") out[key] = value.slice(0, 200);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Écrit une entrée. Ne lève JAMAIS d'erreur : un journal indisponible ne doit
// pas faire échouer l'action journalisée.
export async function logTechnical({ level = "info", category, message, metadata = null, at = new Date() }) {
  try {
    await db.insert(technicalLogs).values({
      occurredAt: at,
      level: LEVELS.includes(level) ? level : "info",
      category: CATEGORIES.includes(category) ? category : "security",
      message: String(message ?? "").slice(0, 500),
      metadata: cleanMetadata(metadata),
    });
  } catch (error) {
    if (!process.env.VITEST) console.error("Journal technique indisponible :", error.message);
  }
}

// Version « tirer et oublier » pour les chemins chauds (middleware HTTP).
export function logTechnicalLater(entry) {
  logTechnical(entry).catch(() => {});
}

// Middleware : toute réponse 5xx est journalisée (route, méthode, statut,
// durée, compte, IP tronquée), jamais le corps. Le nom de l'erreur est posé
// par le gestionnaire d'erreurs d'app.js (res.locals.errorName).
export function httpErrorLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    if (res.statusCode < 500) return;
    logTechnicalLater({
      level: "error",
      category: "http_error",
      message: "Erreur serveur",
      metadata: {
        ...requestMeta(req),
        status: res.statusCode,
        durationMs: Date.now() - start,
        userId: req.user?.id,
        supportUserId: req.supportUser?.id,
        errorName: res.locals?.errorName,
      },
    });
  });
  next();
}

// Purge : entrées de plus de RETENTION_DAYS jours (worker). Renvoie le nombre supprimé.
export async function purgeTechnicalLogs(now = new Date()) {
  const limit = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db.delete(technicalLogs).where(lt(technicalLogs.occurredAt, limit)).returning({ id: technicalLogs.id });
  return rows.length;
}
