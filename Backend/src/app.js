import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import cors from "cors";
import authRouter from "./routes/auth.js";
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
import intakesRouter from "./routes/intakes.js";
import mailWebhooksRouter from "./routes/mailWebhooks.js";
import villageRouter from "./routes/village.js";
import familyDashboardRouter from "./routes/familyDashboard.js";
import doctorSharesRouter from "./routes/doctorShares.js";
import emergencyRouter from "./routes/emergency.js";
import publicRouter from "./routes/public.js";
import accountRouter from "./routes/account.js";
import activityRouter from "./routes/activity.js";
import { requireAuth, requireVerifiedEmail } from "./middleware/auth.js";
import { convertLegacyEmergencyTokens } from "./lib/sharing.js";

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
app.use("/api/invitations", invitationsRouter);
app.use("/api/webhooks/mail", mailWebhooksRouter);
// Lien médecin et fiche d'urgence : publics, sans compte (phase F).
app.use("/api/public", publicRouter);

// Toutes les routes ci-dessous nécessitent une session valide ET une adresse
// courriel vérifiée (règle transverse §10, sans exception). L'isolation
// entre familles (vérification de l'appartenance) est gérée route par route
// via requireFamilyMembership, à l'intérieur de chaque fichier de routes.
app.use("/api/account", requireAuth, requireVerifiedEmail, accountRouter);
app.use("/api/families", requireAuth, requireVerifiedEmail, familiesRouter);
app.use("/api/members", requireAuth, requireVerifiedEmail, membersRouter);
app.use("/api/appointments", requireAuth, requireVerifiedEmail, appointmentsRouter);
app.use("/api/treatments", requireAuth, requireVerifiedEmail, treatmentsRouter);
app.use("/api/vaccinations", requireAuth, requireVerifiedEmail, vaccinationsRouter);
app.use("/api/documents", requireAuth, requireVerifiedEmail, documentsRouter);
// Vue d'ensemble de la famille, réservée aux parents (avant /api/dashboard).
app.use("/api/dashboard/family", requireAuth, requireVerifiedEmail, familyDashboardRouter);
app.use("/api/dashboard", requireAuth, requireVerifiedEmail, dashboardRouter);
app.use("/api/family-memberships", requireAuth, requireVerifiedEmail, familyMembershipsRouter);
app.use("/api/document-roles", requireAuth, requireVerifiedEmail, documentRolesRouter);
app.use("/api/notifications", requireAuth, requireVerifiedEmail, notificationsRouter);
app.use("/api/intakes", requireAuth, requireVerifiedEmail, intakesRouter);
app.use("/api/village", requireAuth, requireVerifiedEmail, villageRouter);
app.use("/api/doctor-shares", requireAuth, requireVerifiedEmail, doctorSharesRouter);
app.use("/api/emergency", requireAuth, requireVerifiedEmail, emergencyRouter);
// Journal d'activité (UC-10) : lecture seule, visibilité calculée par la route.
app.use("/api/activity", requireAuth, requireVerifiedEmail, activityRouter);

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Anciennes fiches d'urgence dont le jeton est encore en clair (avant la
// migration 0013) : chiffrées au démarrage, en arrière-plan. Elles le sont
// aussi à leur première utilisation (lib/sharing.js upgradeEmergencyCard).
// Pas pendant les tests, qui vident la base à leur rythme.
if (!process.env.VITEST) {
  convertLegacyEmergencyTokens()
    .then((n) => n > 0 && console.log(`🔐 ${n} jeton(s) de fiche d'urgence chiffré(s)`))
    .catch((error) => console.error("Conversion des jetons de fiche d'urgence impossible :", error));
}

// Erreurs non rattrapées (JSON mal formé, corps trop gros...) : réponse JSON
// sobre, jamais de trace technique renvoyée au navigateur.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Erreur serveur" : "Requête invalide" });
});

export default app;