import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { doctorShares, families, familyMemberships, pushSubscriptions, refreshTokens, users } from "../db/schema.js";
import { notify } from "../reminders/notify.js";
import {
  sendAccountReinstatedEmail,
  sendAccountSuspendedEmail,
  sendFamilyAccountReinstatedEmail,
  sendFamilyAccountSuspendedEmail,
} from "./mailer.js";
import { logSupportAction } from "./supportAudit.js";
import { isSuspended, suspensionEnd } from "./suspensionStatus.js";

// ── Suspension d'un compte signalé (UC-52) : blocage TEMPORAIRE et RÉVERSIBLE
// Effets : connexion refusée (après un mot de passe correct seulement),
// jetons refusés par requireAuth, sessions révoquées, appareils push
// retirés, liens médecin actifs créés par le compte révoqués. Rien n'est
// supprimé ni archivé : données, fiche et rôles restent intacts. Le compte
// ne reçoit plus aucune notification ; les rappels de santé continuent
// d'arriver aux autres membres (gestionnaires, parents).

export const SUSPENDED_CATEGORY = "account_status";

// Administrateurs familiaux (A1) des familles du compte, hors lui-même.
async function primaryAdminsOf(userId) {
  const spaces = await db
    .select({ familyId: familyMemberships.familyId, familyName: families.name })
    .from(familyMemberships)
    .innerJoin(families, eq(families.id, familyMemberships.familyId))
    .where(eq(familyMemberships.userId, userId));
  const out = [];
  for (const { familyId, familyName } of spaces) {
    const [a1] = await db
      .select({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified })
      .from(familyMemberships)
      .innerJoin(users, eq(users.id, familyMemberships.userId))
      .where(and(eq(familyMemberships.familyId, familyId), eq(familyMemberships.isPrimaryAdmin, true)));
    if (a1 && a1.id !== userId) out.push({ a1, familyId, familyName });
  }
  return out;
}

// Courriel envoyé sans faire échouer l'action (serveur de courriel absent…).
async function safely(send) {
  try {
    await send();
  } catch (error) {
    if (!process.env.VITEST) console.error(error);
  }
}

// Prévient A1 de chaque famille — SANS le motif détaillé (§ cloisonnement :
// le motif ne regarde que la personne et le support).
async function warnFamilyAdmins(user, { suspended, now }) {
  for (const { a1, familyId, familyName } of await primaryAdminsOf(user.id)) {
    await notify({
      user: a1,
      category: SUSPENDED_CATEGORY,
      dedupeKey: `${suspended ? "suspension" : "reprise"}:${user.id}:${now.getTime()}:f${familyId}:u${a1.id}`,
      title: suspended ? "Un compte de votre famille est suspendu" : "Un compte de votre famille est de nouveau actif",
      body: suspended
        ? `Le compte de ${user.name} a été suspendu par le support de SunuSanté Famille. Ses données et sa fiche restent intactes ; les rappels de ses proches continuent d'arriver à leurs gestionnaires.`
        : `La suspension du compte de ${user.name} a été levée.`,
      link: "/famille",
      familyId,
      now,
    });
    await safely(() =>
      (suspended ? sendFamilyAccountSuspendedEmail : sendFamilyAccountReinstatedEmail)({
        to: a1.email,
        name: a1.name,
        memberName: user.name,
        familyName,
      })
    );
  }
}

// Suspend un compte. `until` : Date de fin, ou null (jusqu'à nouvel ordre).
export async function suspendAccount(user, { supportUser, reason, until = null, requestId = null, ip = null, now = new Date() }) {
  const [updated] = await db
    .update(users)
    .set({ suspendedAt: now, suspendedUntil: until, suspensionReason: reason, suspendedBy: supportUser.id })
    .where(eq(users.id, user.id))
    .returning();

  // Toutes les sessions sont fermées (et les jetons d'accès encore valides
  // sont refusés par requireAuth).
  await db.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));
  // Plus aucune notification sur ses appareils.
  const removedDevices = await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id)).returning({ id: pushSubscriptions.id });
  // Liens médecin encore actifs créés par ce compte : révoqués.
  const revokedShares = await db
    .update(doctorShares)
    .set({ revokedAt: now, sessionHash: null })
    .where(and(eq(doctorShares.createdByUserId, user.id), isNull(doctorShares.revokedAt)))
    .returning({ id: doctorShares.id });

  await logSupportAction({
    supportUser,
    action: "account_suspended",
    target: user,
    requestId,
    reason,
    details: { until: until ? until.toISOString() : null, devicesRemoved: removedDevices.length, doctorSharesRevoked: revokedShares.length },
    ip,
    at: now,
  });

  // La personne est prévenue (motif, durée, comment contester) — dernier
  // courriel qu'elle reçoit pendant la suspension.
  await safely(() =>
    sendAccountSuspendedEmail({ to: updated.email, name: updated.name, reason, endLabel: suspensionEnd(updated) })
  );
  await warnFamilyAdmins(updated, { suspended: true, now });
  return updated;
}

// Lève une suspension (manuellement, ou automatiquement à sa date de fin).
export async function liftSuspension(user, { supportUser = null, reason = null, ip = null, requestId = null, now = new Date(), automatic = false }) {
  const [updated] = await db
    .update(users)
    .set({ suspendedAt: null, suspendedUntil: null, suspensionReason: null, suspendedBy: null })
    .where(and(eq(users.id, user.id), isNotNull(users.suspendedAt)))
    .returning();
  if (!updated) return null; // déjà levée
  await logSupportAction({
    supportUser,
    supportEmail: automatic ? "automatique (worker)" : null,
    action: automatic ? "suspension_lifted_auto" : "suspension_lifted",
    target: updated,
    requestId,
    reason: reason ?? (automatic ? "Date de fin de la suspension atteinte" : null),
    ip,
    at: now,
  });
  await safely(() => sendAccountReinstatedEmail({ to: updated.email, name: updated.name }));
  await warnFamilyAdmins(updated, { suspended: false, now });
  return updated;
}

// Worker : suspensions dont la date de fin est passée. Renvoie le nombre levé.
export async function liftExpiredSuspensions(now = new Date()) {
  const due = await db
    .select()
    .from(users)
    .where(and(isNotNull(users.suspendedAt), isNotNull(users.suspendedUntil), lte(users.suspendedUntil, now)));
  let lifted = 0;
  for (const user of due) {
    if (await liftSuspension(user, { now, automatic: true })) lifted += 1;
  }
  return lifted;
}

export { isSuspended };
