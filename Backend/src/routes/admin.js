import { Router } from "express";
import { and, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  emailChangeTokens,
  emailVerificationTokens,
  families,
  familyMemberships,
  passwordResetTokens,
  pushSubscriptions,
  refreshTokens,
  supportAudit,
  supportRequestMessages,
  supportRequests,
  supportUsers,
  technicalLogs,
  users,
} from "../db/schema.js";
import { normalizeEmail, clearEmail, failureCount } from "../lib/loginThrottle.js";
import { generateToken } from "../lib/token.js";
import { hashToken } from "../lib/session.js";
import { issuePasswordReset } from "../lib/passwordReset.js";
import { sendSupportEmailChangedNotice, sendVerificationEmail } from "../lib/mailer.js";
import { deleteAccount } from "../lib/accountDeletion.js";
import { liftSuspension, suspendAccount } from "../lib/suspension.js";
import { isSuspended } from "../lib/suspensionStatus.js";
import { AUDIT_ACTIONS, logSupportAction } from "../lib/supportAudit.js";
import { CATEGORIES as LOG_CATEGORIES, LEVELS as LOG_LEVELS, maskEmail } from "../lib/technicalLog.js";
import {
  CLOSED_STATUSES,
  MAX_MESSAGE_LENGTH,
  OPEN_STATUSES,
  REPORT_REASONS,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  cleanText,
  messagesOf,
  notifyRequester,
} from "../lib/supportRequests.js";

// ── Espace support (acteur A5, M13, UC-50 à 53) — toutes les routes exigent
// la session support (requireSupport, monté dans app.js).
//
// CLOISONNEMENT ABSOLU : le support agit sur les COMPTES et les MÉTADONNÉES
// techniques, jamais sur les dossiers. Aucune route ici ne lit une fiche,
// un rendez-vous, un traitement, un vaccin, un document, une note, une
// allergie, une fiche d'urgence, le journal d'activité d'une famille ni le
// contenu d'une notification. Les seules tables lues : users (colonnes de
// compte), family_memberships / families (nom de la famille, rôle),
// push_subscriptions (nombre), refresh_tokens, support_*, technical_logs.
// Vérifié par test/supportCloisonnement.test.js.

const router = Router();

const MIN_REASON_LENGTH = 5;
const MIN_EMAIL_CHANGE_REASON_LENGTH = 20;
const PAGE_SIZE = 50;
const REASON_ERROR = `Motif obligatoire (${MIN_REASON_LENGTH} caractères minimum)`;

const intParam = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function audit(req, entry) {
  await logSupportAction({ supportUser: req.supportUser, ip: req.ip, ...entry });
}

// ── Métadonnées d'un compte : JAMAIS de contenu médical ──────────────────────
const ROLE_LABELS = { parent: "Co-administrateur", adult: "Membre adulte", dependent: "Membre adolescent" };
// L'administrateur familial (A1) est un parent : libellé dédié.
const roleLabel = (role, isPrimaryAdmin) => (role === "parent" && isPrimaryAdmin ? "Administrateur familial" : ROLE_LABELS[role] ?? role);

async function accountMetadata(userId) {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      suspendedAt: users.suspendedAt,
      suspendedUntil: users.suspendedUntil,
      suspensionReason: users.suspensionReason,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return null;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [failed] = await db
    .select({ n: count() })
    .from(technicalLogs)
    .where(
      and(
        eq(technicalLogs.category, "auth"),
        eq(technicalLogs.level, "warn"),
        gte(technicalLogs.occurredAt, since),
        sql`${technicalLogs.metadata}->>'userId' = ${String(userId)}`
      )
    );
  const [devices] = await db.select({ n: count() }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  const [sessions] = await db
    .select({ n: count() })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt), gte(refreshTokens.expiresAt, new Date())));
  const spaces = await db
    .select({ familyId: families.id, familyName: families.name, role: familyMemberships.role, isPrimaryAdmin: familyMemberships.isPrimaryAdmin })
    .from(familyMemberships)
    .innerJoin(families, eq(families.id, familyMemberships.familyId))
    .where(eq(familyMemberships.userId, userId));
  const requests = await db
    .select({ id: supportRequests.id, reference: supportRequests.reference, type: supportRequests.type, status: supportRequests.status, createdAt: supportRequests.createdAt })
    .from(supportRequests)
    .where(or(eq(supportRequests.userId, userId), eq(supportRequests.requesterUserId, userId)))
    .orderBy(desc(supportRequests.createdAt));
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    failedLogins24h: failed.n,
    currentLoginFailures: failureCount(user.email),
    pushDevices: devices.n,
    openSessions: sessions.n,
    families: spaces.map((s) => ({
      familyId: s.familyId,
      name: s.familyName,
      role: s.role,
      roleLabel: roleLabel(s.role, s.isPrimaryAdmin),
      isPrimaryAdmin: s.isPrimaryAdmin,
    })),
    suspension: isSuspended(user)
      ? { suspendedAt: user.suspendedAt, suspendedUntil: user.suspendedUntil, reason: user.suspensionReason }
      : null,
    requests,
  };
}

// ── Accueil ──────────────────────────────────────────────────────────────────
router.get("/dashboard", async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const pending = await db
      .select({ type: supportRequests.type, status: supportRequests.status, n: count() })
      .from(supportRequests)
      .where(inArray(supportRequests.status, ["unverified", "open", "in_progress"]))
      .groupBy(supportRequests.type, supportRequests.status);
    const suspended = await db
      .select({ id: users.id, name: users.name, email: users.email, suspendedAt: users.suspendedAt, suspendedUntil: users.suspendedUntil })
      .from(users)
      .where(isNotNull(users.suspendedAt))
      .orderBy(desc(users.suspendedAt));
    const [lastWorker] = await db
      .select({ occurredAt: technicalLogs.occurredAt, level: technicalLogs.level, message: technicalLogs.message, metadata: technicalLogs.metadata })
      .from(technicalLogs)
      .where(eq(technicalLogs.category, "worker"))
      .orderBy(desc(technicalLogs.occurredAt), desc(technicalLogs.id))
      .limit(1);
    const [errors] = await db
      .select({ n: count() })
      .from(technicalLogs)
      .where(and(eq(technicalLogs.level, "error"), gte(technicalLogs.occurredAt, since)));
    const [emailFailures] = await db
      .select({ n: count() })
      .from(technicalLogs)
      .where(and(eq(technicalLogs.category, "email"), eq(technicalLogs.level, "error"), gte(technicalLogs.occurredAt, since)));
    const byType = Object.fromEntries(REQUEST_TYPES.map((t) => [t, { unverified: 0, open: 0, in_progress: 0 }]));
    for (const row of pending) if (byType[row.type]) byType[row.type][row.status] = row.n;
    res.json({
      requestsByType: byType,
      suspendedAccounts: suspended,
      worker: lastWorker ?? null,
      errorsLast24h: errors.n,
      emailFailuresLast24h: emailFailures.n,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── Comptes ──────────────────────────────────────────────────────────────────
router.get("/accounts", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    if (q.length < 2) return res.json([]);
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        suspendedAt: users.suspendedAt,
        suspendedUntil: users.suspendedUntil,
      })
      .from(users)
      .where(or(ilike(users.email, pattern), ilike(users.name, pattern)))
      .orderBy(users.email)
      .limit(50);
    await audit(req, { action: "account_searched", details: { recherche: q, resultats: rows.length } });
    res.json(
      rows.map(({ suspendedAt, suspendedUntil, ...u }) => ({ ...u, suspended: isSuspended({ suspendedAt, suspendedUntil }) }))
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/accounts/:id", async (req, res) => {
  try {
    const id = intParam(req.params.id);
    const account = id ? await accountMetadata(id) : null;
    if (!account) return res.status(404).json({ error: "Compte introuvable" });
    await audit(req, { action: "account_viewed", target: account });
    res.json(account);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Levée manuelle d'une suspension, à tout moment, avec motif.
router.post("/accounts/:id/unsuspend", async (req, res) => {
  try {
    const id = intParam(req.params.id);
    const reason = cleanText(req.body?.reason, { min: MIN_REASON_LENGTH, max: 2000 });
    if (!reason) return res.status(400).json({ error: REASON_ERROR });
    const [user] = id ? await db.select().from(users).where(eq(users.id, id)) : [];
    if (!user) return res.status(404).json({ error: "Compte introuvable" });
    if (!user.suspendedAt) return res.status(409).json({ error: "Ce compte n'est pas suspendu" });
    await liftSuspension(user, { supportUser: req.supportUser, reason, ip: req.ip, requestId: intParam(req.body?.requestId) });
    res.json(await accountMetadata(id));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── Demandes ─────────────────────────────────────────────────────────────────
const requestListColumns = {
  id: supportRequests.id,
  reference: supportRequests.reference,
  type: supportRequests.type,
  status: supportRequests.status,
  accountEmail: supportRequests.accountEmail,
  contactEmail: supportRequests.contactEmail,
  userId: supportRequests.userId,
  reportReason: supportRequests.reportReason,
  createdAt: supportRequests.createdAt,
  updatedAt: supportRequests.updatedAt,
  assignedTo: supportRequests.assignedTo,
  assignedToName: supportUsers.name,
};

router.get("/requests", async (req, res) => {
  try {
    const filters = [];
    if (REQUEST_TYPES.includes(req.query.type)) filters.push(eq(supportRequests.type, req.query.type));
    if (REQUEST_STATUSES.includes(req.query.status)) filters.push(eq(supportRequests.status, req.query.status));
    if (req.query.status === "pending") filters.push(inArray(supportRequests.status, ["unverified", "open", "in_progress"]));
    const rows = await db
      .select(requestListColumns)
      .from(supportRequests)
      .leftJoin(supportUsers, eq(supportUsers.id, supportRequests.assignedTo))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(supportRequests.createdAt), desc(supportRequests.id))
      .limit(200);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

async function loadRequest(req, res) {
  const id = intParam(req.params.id);
  const [request] = id ? await db.select().from(supportRequests).where(eq(supportRequests.id, id)) : [];
  if (!request) {
    res.status(404).json({ error: "Demande introuvable" });
    return null;
  }
  return request;
}

async function requestDetail(request) {
  const messages = await db
    .select({
      id: supportRequestMessages.id,
      authorType: supportRequestMessages.authorType,
      authorName: supportRequestMessages.authorName,
      body: supportRequestMessages.body,
      createdAt: supportRequestMessages.createdAt,
    })
    .from(supportRequestMessages)
    .where(eq(supportRequestMessages.requestId, request.id))
    .orderBy(supportRequestMessages.createdAt, supportRequestMessages.id);
  let requester = null;
  if (request.requesterUserId && request.requesterUserId !== request.userId) {
    const [r] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, request.requesterUserId));
    requester = r ?? null;
  }
  let family = null;
  if (request.familyId) {
    const [f] = await db.select({ id: families.id, name: families.name }).from(families).where(eq(families.id, request.familyId));
    family = f ?? null;
  }
  let assignedToName = null;
  if (request.assignedTo) {
    const [s] = await db.select({ name: supportUsers.name }).from(supportUsers).where(eq(supportUsers.id, request.assignedTo));
    assignedToName = s?.name ?? null;
  }
  return {
    request: {
      id: request.id,
      reference: request.reference,
      type: request.type,
      status: request.status,
      userId: request.userId,
      accountEmail: request.accountEmail,
      contactEmail: request.contactEmail,
      newEmail: request.newEmail,
      reportReason: request.reportReason,
      reportReasonLabel: REPORT_REASONS[request.reportReason] ?? null,
      description: request.description,
      deleteMedicalRecord: request.deleteMedicalRecord,
      verifiedAt: request.verifiedAt,
      verifiedOfflineAt: request.verifiedOfflineAt,
      assignedTo: request.assignedTo,
      assignedToName,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      resolvedAt: request.resolvedAt,
    },
    messages,
    account: request.userId ? await accountMetadata(request.userId) : null,
    requester,
    family,
  };
}

router.get("/requests/:id", async (req, res) => {
  try {
    const request = await loadRequest(req, res);
    if (!request) return;
    const detail = await requestDetail(request);
    await audit(req, { action: "request_viewed", requestId: request.id, target: detail.account });
    res.json(detail);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

async function touch(request, values = {}) {
  const now = new Date();
  const [updated] = await db
    .update(supportRequests)
    .set({ ...values, updatedAt: now })
    .where(eq(supportRequests.id, request.id))
    .returning();
  return updated;
}

router.post("/requests/:id/assign", async (req, res) => {
  try {
    const request = await loadRequest(req, res);
    if (!request) return;
    const updated = await touch(request, {
      assignedTo: req.supportUser.id,
      status: request.status === "open" ? "in_progress" : request.status,
    });
    await audit(req, { action: "request_assigned", requestId: request.id, details: { status: updated.status } });
    if (updated.status !== request.status) await notifyRequester(updated, { status: updated.status });
    res.json(await requestDetail(updated));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Changement de statut. Une demande « non vérifiée » ne peut être ouverte que
// si le support a vérifié l'identité HORS application (case + motif).
router.post("/requests/:id/status", async (req, res) => {
  try {
    const request = await loadRequest(req, res);
    if (!request) return;
    const status = req.body?.status;
    if (!["open", "in_progress", "resolved", "rejected"].includes(status)) return res.status(400).json({ error: "Statut invalide" });
    if (status === request.status) return res.status(409).json({ error: "La demande a déjà ce statut" });
    const reason = cleanText(req.body?.reason, { min: MIN_REASON_LENGTH, max: 2000 });
    const values = { status };
    if (request.status === "unverified") {
      if (status === "open" || status === "in_progress") {
        if (req.body?.identityVerifiedOffline !== true || !reason) {
          return res.status(400).json({
            error: "Demande non vérifiée : cochez « Identité vérifiée hors application » et indiquez comment l'identité a été vérifiée",
          });
        }
        values.verifiedOfflineAt = new Date();
      } else if (status === "resolved") {
        return res.status(409).json({ error: "Une demande non vérifiée ne peut qu'être ouverte (identité vérifiée) ou refusée" });
      }
    }
    if (status === "rejected" && !reason) return res.status(400).json({ error: REASON_ERROR });
    values.resolvedAt = CLOSED_STATUSES.includes(status) ? new Date() : null;
    const updated = await touch(request, values);
    await audit(req, {
      action: "request_status_changed",
      requestId: request.id,
      target: request.userId ? { id: request.userId, email: request.accountEmail } : null,
      reason,
      details: { from: request.status, to: status, identityVerifiedOffline: Boolean(values.verifiedOfflineAt) },
    });
    await notifyRequester(updated, { status });
    res.json(await requestDetail(updated));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/requests/:id/reply", async (req, res) => {
  try {
    const request = await loadRequest(req, res);
    if (!request) return;
    const body = cleanText(req.body?.message, { max: MAX_MESSAGE_LENGTH });
    if (!body) return res.status(400).json({ error: `Message requis (${MAX_MESSAGE_LENGTH} caractères maximum)` });
    await db.insert(supportRequestMessages).values({
      requestId: request.id,
      authorType: "support",
      supportUserId: req.supportUser.id,
      authorName: req.supportUser.name,
      body,
    });
    const updated = await touch(request);
    await audit(req, { action: "request_replied", requestId: request.id });
    await notifyRequester(updated, { message: body });
    res.status(201).json(await requestDetail(updated));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── Actions sur une demande : motif obligatoire, auditées ────────────────────
// Garde commune : type attendu, demande vérifiée et ouverte (sauf mention),
// compte concerné existant.
async function actionContext(req, res, { type, requireVerified = true }) {
  const request = await loadRequest(req, res);
  if (!request) return null;
  if (request.type !== type) {
    res.status(409).json({ error: "Action impossible pour ce type de demande" });
    return null;
  }
  const allowed = requireVerified ? OPEN_STATUSES : ["unverified", ...OPEN_STATUSES];
  if (!allowed.includes(request.status)) {
    res.status(409).json({
      error: requireVerified
        ? "La demande doit être vérifiée et ouverte (statut « ouverte » ou « en cours ») pour cette action"
        : "La demande est close",
    });
    return null;
  }
  const reason = cleanText(req.body?.reason, { min: MIN_REASON_LENGTH, max: 2000 });
  if (!reason) {
    res.status(400).json({ error: REASON_ERROR });
    return null;
  }
  const [user] = request.userId ? await db.select().from(users).where(eq(users.id, request.userId)) : [];
  if (!user) {
    res.status(409).json({ error: "Aucun compte n'est rattaché à cette demande (adresse inconnue ou compte supprimé)" });
    return null;
  }
  return { request, reason, user };
}

// UC-50 (a) : lien de réinitialisation du mot de passe, envoyé À L'ADRESSE DU
// COMPTE (mécanisme « Mot de passe oublié »). Le support ne voit ni ne
// définit jamais de mot de passe.
router.post("/requests/:id/send-reset-link", async (req, res) => {
  try {
    const ctx = await actionContext(req, res, { type: "recovery" });
    if (!ctx) return;
    await issuePasswordReset(ctx.user);
    await audit(req, { action: "reset_link_sent", requestId: ctx.request.id, target: ctx.user, reason: ctx.reason });
    await touch(ctx.request, { status: "in_progress" });
    res.json({ success: true, sentTo: maskEmail(ctx.user.email) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// UC-50 (b) : débloque le limiteur de connexion du compte.
router.post("/requests/:id/unlock", async (req, res) => {
  try {
    const ctx = await actionContext(req, res, { type: "recovery" });
    if (!ctx) return;
    clearEmail(ctx.user.email);
    await audit(req, { action: "login_unlocked", requestId: ctx.request.id, target: ctx.user, reason: ctx.reason });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// UC-50 (c) : nouvelle adresse du compte — UNIQUEMENT après vérification de
// l'identité hors application (case cochée + motif détaillé). Possible sur
// une demande non vérifiée (boîte perdue : le lien n'a pas pu être suivi).
// L'ancienne adresse reçoit un avis, la nouvelle un lien de vérification ;
// toutes les sessions du compte sont fermées.
router.post("/requests/:id/change-email", async (req, res) => {
  try {
    if (req.body?.identityVerifiedOffline !== true) {
      return res.status(400).json({ error: "Cochez « Identité vérifiée hors application » : le changement d'adresse l'exige" });
    }
    const detailed = cleanText(req.body?.reason, { min: MIN_EMAIL_CHANGE_REASON_LENGTH, max: 2000 });
    if (!detailed) {
      return res.status(400).json({ error: `Motif détaillé obligatoire (${MIN_EMAIL_CHANGE_REASON_LENGTH} caractères minimum) : comment l'identité a-t-elle été vérifiée ?` });
    }
    const ctx = await actionContext(req, res, { type: "recovery", requireVerified: false });
    if (!ctx) return;
    const newEmail = normalizeEmail(req.body?.newEmail ?? ctx.request.newEmail);
    if (!newEmail) return res.status(400).json({ error: "Nouvelle adresse invalide" });
    if (newEmail === ctx.user.email) return res.status(400).json({ error: "C'est déjà l'adresse du compte" });
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, newEmail));
    if (taken) return res.status(409).json({ error: "Un autre compte utilise déjà cette adresse" });

    // Arrondi à la seconde SUPÉRIEURE : tout jeton d'accès déjà émis (même
    // dans cette seconde) est refusé par requireAuth.
    const now = new Date(Math.ceil(Date.now() / 1000) * 1000);
    const oldEmail = ctx.user.email;
    await db.update(users).set({ email: newEmail, emailVerified: false, passwordChangedAt: now }).where(eq(users.id, ctx.user.id));
    await db.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.userId, ctx.user.id), isNull(refreshTokens.revokedAt)));
    // Liens encore valides envoyés à l'ancienne adresse : annulés.
    await db
      .update(passwordResetTokens)
      .set({ consumedAt: now })
      .where(and(eq(passwordResetTokens.userId, ctx.user.id), isNull(passwordResetTokens.consumedAt)));
    await db
      .update(emailChangeTokens)
      .set({ consumedAt: now })
      .where(and(eq(emailChangeTokens.userId, ctx.user.id), isNull(emailChangeTokens.consumedAt)));
    await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, ctx.user.id));
    clearEmail(oldEmail);

    const token = generateToken();
    await db.insert(emailVerificationTokens).values({
      userId: ctx.user.id,
      token: hashToken(token),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    });
    try {
      await sendVerificationEmail({ to: newEmail, name: ctx.user.name, token });
    } catch (error) {
      console.error(error);
    }
    try {
      await sendSupportEmailChangedNotice({ to: oldEmail, name: ctx.user.name, newEmailMasked: maskEmail(newEmail) });
    } catch (error) {
      console.error(error);
    }

    await audit(req, {
      action: "email_changed",
      requestId: ctx.request.id,
      target: { id: ctx.user.id, email: oldEmail },
      reason: detailed,
      details: { ancienneAdresse: oldEmail, nouvelleAdresse: newEmail, identityVerifiedOffline: true },
    });
    const updated = await touch(ctx.request, { verifiedOfflineAt: new Date(), status: "in_progress", contactEmail: newEmail });
    await notifyRequester(updated, { status: "in_progress" });
    res.json(await requestDetail(updated));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// UC-51 : suppression du compte, avec les MÊMES règles que la suppression
// par la personne (lib/accountDeletion.js). Double confirmation : l'adresse
// du compte, retapée. La fiche médicale n'est effacée que si la personne l'a
// demandé explicitement dans sa demande.
router.post("/requests/:id/delete-account", async (req, res) => {
  try {
    const ctx = await actionContext(req, res, { type: "data_deletion" });
    if (!ctx) return;
    if (normalizeEmail(req.body?.confirmEmail) !== ctx.user.email) {
      return res.status(400).json({ error: "Confirmation incorrecte : retapez exactement l'adresse du compte" });
    }
    const deleteMyFiche = req.body?.deleteMedicalRecord === true;
    if (deleteMyFiche && !ctx.request.deleteMedicalRecord) {
      return res.status(400).json({ error: "La personne n'a pas demandé la suppression de sa fiche médicale" });
    }
    const result = await deleteAccount(ctx.user, { deleteMyFiche, bySupport: true });
    if (!result.ok) return res.status(409).json({ error: result.error });
    await audit(req, {
      action: "account_deleted",
      requestId: ctx.request.id,
      target: ctx.user,
      reason: ctx.reason,
      details: { ficheMedicaleSupprimee: deleteMyFiche },
    });
    const updated = await touch(ctx.request, { status: "resolved", resolvedAt: new Date() });
    await notifyRequester(updated, { status: "resolved" });
    res.json(await requestDetail(updated));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// UC-52 : suspension d'un compte signalé (signalement instruit).
router.post("/requests/:id/suspend", async (req, res) => {
  try {
    const ctx = await actionContext(req, res, { type: "report" });
    if (!ctx) return;
    let until = null;
    if (req.body?.until) {
      until = new Date(req.body.until);
      if (Number.isNaN(until.getTime()) || until <= new Date()) {
        return res.status(400).json({ error: "Date de fin invalide : elle doit être dans le futur (ou vide : jusqu'à nouvel ordre)" });
      }
    }
    if (isSuspended(ctx.user)) return res.status(409).json({ error: "Ce compte est déjà suspendu" });
    await suspendAccount(ctx.user, { supportUser: req.supportUser, reason: ctx.reason, until, requestId: ctx.request.id, ip: req.ip });
    const updated = await touch(ctx.request, { status: "in_progress" });
    res.json(await requestDetail(updated));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── Journaux techniques (UC-53) ──────────────────────────────────────────────
router.get("/logs", async (req, res) => {
  try {
    const filters = [];
    if (LOG_LEVELS.includes(req.query.level)) filters.push(eq(technicalLogs.level, req.query.level));
    if (LOG_CATEGORIES.includes(req.query.category)) filters.push(eq(technicalLogs.category, req.query.category));
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    if (from && !Number.isNaN(from.getTime())) filters.push(gte(technicalLogs.occurredAt, from));
    if (to && !Number.isNaN(to.getTime())) filters.push(lte(technicalLogs.occurredAt, to));
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    if (q) {
      const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      filters.push(or(ilike(technicalLogs.message, pattern), sql`${technicalLogs.metadata}::text ilike ${pattern}`));
    }
    const page = Math.max(1, intParam(req.query.page) ?? 1);
    const where = filters.length ? and(...filters) : undefined;
    const [{ n: total }] = await db.select({ n: count() }).from(technicalLogs).where(where);
    const items = await db
      .select()
      .from(technicalLogs)
      .where(where)
      .orderBy(desc(technicalLogs.occurredAt), desc(technicalLogs.id))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE);
    await audit(req, {
      action: "logs_viewed",
      details: { level: req.query.level ?? null, category: req.query.category ?? null, recherche: q || null, page },
    });
    res.json({ items, total, page, pageSize: PAGE_SIZE, levels: LOG_LEVELS, categories: LOG_CATEGORIES });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── Journal d'audit du support (lecture seule, ineffaçable) ──────────────────
router.get("/audit", async (req, res) => {
  try {
    const filters = [];
    if (typeof req.query.action === "string" && AUDIT_ACTIONS[req.query.action]) filters.push(eq(supportAudit.action, req.query.action));
    const page = Math.max(1, intParam(req.query.page) ?? 1);
    const where = filters.length ? and(...filters) : undefined;
    const [{ n: total }] = await db.select({ n: count() }).from(supportAudit).where(where);
    const items = await db
      .select()
      .from(supportAudit)
      .where(where)
      .orderBy(desc(supportAudit.occurredAt), desc(supportAudit.id))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE);
    await audit(req, { action: "audit_viewed", details: { page } });
    res.json({
      items: items.map((e) => ({ ...e, actionLabel: AUDIT_ACTIONS[e.action] ?? e.action })),
      total,
      page,
      pageSize: PAGE_SIZE,
      actions: AUDIT_ACTIONS,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
