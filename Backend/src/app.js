import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import cors from "cors";
import authRouter from "./routes/auth.js";
import googleAuthRouter from "./routes/google.js";
import familiesRouter from "./routes/families.js";
import membersRouter from "./routes/members.js";
import appointmentsRouter from "./routes/appointments.js";
import treatmentsRouter from "./routes/treatments.js";
import vaccinationsRouter from "./routes/vaccinations.js";
import documentsRouter from "./routes/documents.js";
import dashboardRouter from "./routes/dashboard.js";
import invitationsRouter from "./routes/invitations.js";
import familyMembershipsRouter from "./routes/familyMemberships.js";
import documentRolesRouter from "./routes/documentRoles.js";
import uploadsRouter from "./routes/uploads.js";
import notificationsRouter from "./routes/notifications.js";
import intakesRouter, { intakeActionRouter } from "./routes/intakes.js";
import pushRouter from "./routes/push.js";
import mailWebhooksRouter from "./routes/mailWebhooks.js";
import villageRouter from "./routes/village.js";
import familyDashboardRouter from "./routes/familyDashboard.js";
import doctorSharesRouter from "./routes/doctorShares.js";
import emergencyRouter from "./routes/emergency.js";
import publicRouter from "./routes/public.js";
import accountRouter from "./routes/account.js";
import activityRouter from "./routes/activity.js";
import roleTransfersRouter from "./routes/roleTransfers.js";
import reminderSettingsRouter from "./routes/reminderSettings.js";
import { exportDownloadRouter, familyExportRouter, memberExportRouter } from "./routes/exports.js";
import adminAuthRouter from "./routes/adminAuth.js";
import adminRouter from "./routes/admin.js";
import { supportPublicRouter, supportRouter } from "./routes/support.js";
import { requireSupport } from "./middleware/supportAuth.js";
import { httpErrorLogger } from "./lib/technicalLog.js";
import { requireAuth, requireVerifiedEmail } from "./middleware/auth.js";
import { convertLegacyEmergencyTokens } from "./lib/sharing.js";
import { encryptLegacyDocuments } from "./lib/documentFiles.js";
import { pushConfig } from "./lib/push.js";

const app = express();

app.disable("x-powered-by");
// Derrière nginx (conteneur frontend) : un seul proxy de confiance. req.ip
// est alors l'adresse du visiteur lue dans X-Forwarded-For (posé par nginx),
// et non celle de nginx — indispensable aux limites par adresse IP. Sans
// proxy devant (npm run dev), un client pourrait choisir cet en-tête : l'API
// ne doit donc jamais être exposée directement sur Internet.
app.set("trust proxy", 1);
// En-têtes de sécurité (anti-clickjacking, nosniff, CSP stricte : l'API ne
// sert que du JSON et des fichiers). Les fichiers téléversés posent leur
// propre politique (sendStoredFile), d'où contentSecurityPolicy laissé à
// helmet pour le reste.
app.use(
  helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-origin" },
  })
);
// Seule origine autorisée : celle de l'application (FRONTEND_URL).
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173", credentials: true }));
// Requêtes qui modifient des données : refusées si elles viennent d'une autre
// origine que l'application (protection CSRF en plus des cookies
// SameSite=Strict, qui ne couvrent pas un sous-domaine voisin). Sans en-tête
// Origin (outils, tests, anciens navigateurs), la requête passe : les cookies
// SameSite et le CORS s'appliquent alors seuls.
const FRONTEND_ORIGIN = new URL(process.env.FRONTEND_URL || "http://localhost:5173").origin;
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path.startsWith("/api/webhooks/")) return next();
  const origin = req.get("origin");
  if (!origin) return next();
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: "Origine refusée" });
  }
  if (origin === FRONTEND_ORIGIN || host === req.get("host")) return next();
  res.status(403).json({ error: "Origine refusée" });
});
// Journal technique (UC-53) : toute réponse 5xx est notée (route, méthode,
// statut, durée — jamais le corps de la requête ni de la réponse).
app.use(httpErrorLogger);
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

// Réponses de l'API : jamais mises en cache (navigateur, proxy, ordinateur
// partagé) — elles contiennent des données de santé. Les fichiers servis
// posent leur propre politique (sendStoredFile), tout aussi stricte.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Fichiers téléversés : contrôle d'accès au dossier, comme les données médicales.
app.use("/uploads", requireAuth, requireVerifiedEmail, uploadsRouter);

app.use("/api/auth", authRouter);
// « Continuer avec Google » : /api/auth/config, /api/auth/google… (facultatif,
// actif seulement si GOOGLE_CLIENT_ID est définie).
app.use("/api/auth", googleAuthRouter);
app.use("/api/invitations", invitationsRouter);
app.use("/api/webhooks/mail", mailWebhooksRouter);
// Lien médecin et fiche d'urgence : publics, sans compte (phase F).
app.use("/api/public", publicRouter);
// Boutons « Pris » / « Pas pris » d'une notification push : sans session,
// autorisés par le jeton d'action de la notification (routes/intakes.js).
app.use("/api/intakes", intakeActionRouter);
// Support : « Je n'arrive plus à accéder à mon compte » et lien de
// confirmation d'une demande (sans session).
app.use("/api/support/public", supportPublicRouter);

// Espace support (acteur A5, UC-50 à 53) : session SÉPARÉE (cookie
// admin_token, mot de passe + code à usage unique). Une session famille n'y
// donne jamais accès, et une session support n'ouvre aucune route famille
// (requireAuth ne lit que le cookie access_token).
app.use("/api/admin/auth", adminAuthRouter);
app.use("/api/admin", requireSupport, adminRouter);

// Toutes les routes ci-dessous nécessitent une session valide ET une adresse
// courriel vérifiée (règle transverse §10, sans exception). L'isolation
// entre familles (vérification de l'appartenance) est gérée route par route
// via requireFamilyMembership, à l'intérieur de chaque fichier de routes.
app.use("/api/account", requireAuth, requireVerifiedEmail, accountRouter);
app.use("/api/families", requireAuth, requireVerifiedEmail, familiesRouter);
// Archive ZIP de la famille (UC-09) : POST /api/families/:id/export, historique
app.use("/api/families", requireAuth, requireVerifiedEmail, familyExportRouter);
app.use("/api/members", requireAuth, requireVerifiedEmail, membersRouter);
// Dossier médical en PDF (UC-27) : GET /api/members/:id/export.pdf
app.use("/api/members", requireAuth, requireVerifiedEmail, memberExportRouter);
app.use("/api/appointments", requireAuth, requireVerifiedEmail, appointmentsRouter);
app.use("/api/treatments", requireAuth, requireVerifiedEmail, treatmentsRouter);
app.use("/api/vaccinations", requireAuth, requireVerifiedEmail, vaccinationsRouter);
app.use("/api/documents", requireAuth, requireVerifiedEmail, documentsRouter);
// Vue d'ensemble de la famille, réservée aux parents (avant /api/dashboard).
app.use("/api/dashboard/family", requireAuth, requireVerifiedEmail, familyDashboardRouter);
app.use("/api/dashboard", requireAuth, requireVerifiedEmail, dashboardRouter);
app.use("/api/family-memberships", requireAuth, requireVerifiedEmail, familyMembershipsRouter);
app.use("/api/document-roles", requireAuth, requireVerifiedEmail, documentRolesRouter);
// Transfert de la gestion d'un dossier (UC-39) et règles de rappel du Village (UC-08).
app.use("/api/role-transfers", requireAuth, requireVerifiedEmail, roleTransfersRouter);
app.use("/api/reminder-settings", requireAuth, requireVerifiedEmail, reminderSettingsRouter);
app.use("/api/notifications", requireAuth, requireVerifiedEmail, notificationsRouter);
app.use("/api/intakes", requireAuth, requireVerifiedEmail, intakesRouter);
// Notifications push : abonnement des appareils (application installable).
app.use("/api/push", requireAuth, requireVerifiedEmail, pushRouter);
app.use("/api/village", requireAuth, requireVerifiedEmail, villageRouter);
app.use("/api/doctor-shares", requireAuth, requireVerifiedEmail, doctorSharesRouter);
app.use("/api/emergency", requireAuth, requireVerifiedEmail, emergencyRouter);
// Journal d'activité (UC-10) : lecture seule, visibilité calculée par la route.
app.use("/api/activity", requireAuth, requireVerifiedEmail, activityRouter);
// Demandes au support (« Contacter le support », « Signaler un compte », « Mes demandes »).
app.use("/api/support", requireAuth, requireVerifiedEmail, supportRouter);
// Lien de téléchargement de l'archive (reçu par courriel) : exige aussi d'être
// connecté avec le compte qui l'a demandée.
app.use("/api/exports", requireAuth, requireVerifiedEmail, exportDownloadRouter);

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Anciennes fiches d'urgence dont le jeton est encore en clair (avant la
// migration 0013) : chiffrées au démarrage, en arrière-plan. Elles le sont
// aussi à leur première utilisation (lib/sharing.js upgradeEmergencyCard).
// Pas pendant les tests, qui vident la base à leur rythme.
if (!process.env.VITEST) {
  // Clés VAPID absentes ou invalides : avertissement, push désactivé.
  pushConfig();

  convertLegacyEmergencyTokens()
    .then((n) => n > 0 && console.log(`🔐 ${n} jeton(s) de fiche d'urgence chiffré(s)`))
    .catch((error) => console.error("Conversion des jetons de fiche d'urgence impossible :", error));

  // Documents téléversés avant le chiffrement au repos : chiffrés un à un,
  // en arrière-plan, sans interruption (lib/documentFiles.js).
  encryptLegacyDocuments()
    .then(({ encrypted, alreadyEncrypted, missing, errors }) => {
      if (encrypted + alreadyEncrypted + missing + errors === 0) return;
      const absents = missing > 0 ? `, ${missing} fichier(s) introuvable(s)` : "";
      console.log(`🔐 ${encrypted} document(s) chiffré(s), ${alreadyEncrypted} déjà chiffré(s), ${errors} erreur(s)${absents}`);
    })
    .catch((error) => console.error("Chiffrement des anciens documents impossible :", error));
}

// Erreurs non rattrapées (JSON mal formé, corps trop gros...) : réponse JSON
// sobre, jamais de trace technique renvoyée au navigateur.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  // Nom de l'erreur (TypeError…) pour le journal technique, jamais son contenu.
  res.locals.errorName = typeof err?.name === "string" ? err.name.slice(0, 60) : undefined;
  res.status(status).json({ error: status >= 500 ? "Erreur serveur" : "Requête invalide" });
});

export default app;