import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { requireAuth, requireVerifiedEmail } from "./middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173", credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use("/uploads", requireAuth, express.static(path.join(__dirname, "..", "uploads")));

app.use("/api/auth", authRouter);
app.use("/api/invitations", invitationsRouter);

// Toutes les routes ci-dessous nécessitent une session valide ET une adresse
// courriel vérifiée (règle transverse §10, sans exception). L'isolation
// entre familles (vérification de l'appartenance) est gérée route par route
// via requireFamilyMembership, à l'intérieur de chaque fichier de routes.
app.use("/api/families", requireAuth, requireVerifiedEmail, familiesRouter);
app.use("/api/members", requireAuth, requireVerifiedEmail, membersRouter);
app.use("/api/appointments", requireAuth, requireVerifiedEmail, appointmentsRouter);
app.use("/api/treatments", requireAuth, requireVerifiedEmail, treatmentsRouter);
app.use("/api/vaccinations", requireAuth, requireVerifiedEmail, vaccinationsRouter);
app.use("/api/documents", requireAuth, requireVerifiedEmail, documentsRouter);
app.use("/api/dashboard", requireAuth, requireVerifiedEmail, dashboardRouter);
app.use("/api/family-memberships", requireAuth, requireVerifiedEmail, familyMembershipsRouter);
app.use("/api/document-roles", requireAuth, requireVerifiedEmail, documentRolesRouter);

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

export default app;