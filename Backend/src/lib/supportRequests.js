import crypto from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { supportRequestMessages, supportRequests, users } from "../db/schema.js";
import { hashToken } from "./session.js";
import { sendSupportConfirmationEmail, sendSupportUpdateEmail } from "./mailer.js";

// ── Demandes adressées au support (UC-50 à 52) ───────────────────────────────
// Jamais de donnée médicale demandée : les formulaires le rappellent (« N'indiquez
// aucune information médicale »), et aucune route du support ne lit un dossier.

export const REQUEST_TYPES = ["recovery", "data_deletion", "report", "other"];
export const REQUEST_STATUSES = ["unverified", "open", "in_progress", "resolved", "rejected"];
export const OPEN_STATUSES = ["open", "in_progress"];
export const CLOSED_STATUSES = ["resolved", "rejected"];
export const REPORT_REASONS = { abusive: "Comportement abusif", usurped: "Compte usurpé", other: "Autre" };
export const MIN_DESCRIPTION_LENGTH = 10;
export const MAX_DESCRIPTION_LENGTH = 4000;
export const MAX_MESSAGE_LENGTH = 4000;
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

// Texte libre saisi par l'utilisateur ou le support : chaîne nettoyée, ou null.
export function cleanText(value, { min = 1, max = MAX_MESSAGE_LENGTH } = {}) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length < min || text.length > max) return null;
  return text;
}

// « SUP-2026-0042 » : année de création + numéro de la demande.
export const referenceFor = (id, date = new Date()) => `SUP-${date.getUTCFullYear()}-${String(id).padStart(4, "0")}`;

// Crée une demande. Avec `verify`, un lien de confirmation à usage unique
// (24 h) part à `verifyEmail` (l'adresse DU COMPTE) : la demande reste
// « non vérifiée » jusqu'à ce qu'il soit suivi.
export async function createSupportRequest(values, { verify = null, now = new Date() } = {}) {
  const token = verify ? crypto.randomBytes(32).toString("base64url") : null;
  // Demande d'un compte connecté sans lien à suivre (question, signalement) :
  // l'identité est celle de la session, la demande est ouverte d'emblée.
  const status = values.status ?? (verify ? "unverified" : "open");
  const [inserted] = await db
    .insert(supportRequests)
    .values({
      ...values,
      status,
      verificationTokenHash: token ? hashToken(token) : null,
      verificationExpiresAt: token ? new Date(now.getTime() + VERIFICATION_TTL_MS) : null,
      verifiedAt: status === "unverified" ? null : now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const [request] = await db
    .update(supportRequests)
    .set({ reference: referenceFor(inserted.id, now) })
    .where(eq(supportRequests.id, inserted.id))
    .returning();
  if (token) {
    try {
      await sendSupportConfirmationEmail({ to: verify.email, name: verify.name, token, reference: request.reference, type: request.type });
    } catch (error) {
      if (!process.env.VITEST) console.error(error);
    }
  }
  return { request, token };
}

// Prévient l'auteur de la demande (statut changé, ou réponse du support).
// Un échec d'envoi ne fait pas échouer l'action du support.
export async function notifyRequester(request, { status = null, message = null } = {}) {
  let name = "";
  if (request.requesterUserId) {
    const [requester] = await db.select({ name: users.name }).from(users).where(eq(users.id, request.requesterUserId));
    name = requester?.name ?? "";
  }
  try {
    await sendSupportUpdateEmail({ to: request.contactEmail, name, reference: request.reference, status, message });
  } catch (error) {
    if (!process.env.VITEST) console.error(error);
  }
}

export async function messagesOf(requestIds) {
  if (requestIds.length === 0) return [];
  return db
    .select()
    .from(supportRequestMessages)
    .where(inArray(supportRequestMessages.requestId, requestIds))
    .orderBy(asc(supportRequestMessages.createdAt), asc(supportRequestMessages.id));
}

// Vue de l'utilisateur sur SA demande (« Mes demandes ») : ni le nom du
// membre du support, ni les champs internes.
export function presentForUser(request, messages) {
  return {
    id: request.id,
    reference: request.reference,
    type: request.type,
    status: request.status,
    reportReason: request.reportReason,
    description: request.description,
    deleteMedicalRecord: request.deleteMedicalRecord,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    messages: messages
      .filter((m) => m.requestId === request.id)
      .map((m) => ({
        id: m.id,
        author: m.authorType === "support" ? "Support SunuSanté Famille" : m.authorName,
        fromSupport: m.authorType === "support",
        body: m.body,
        createdAt: m.createdAt,
      })),
  };
}
