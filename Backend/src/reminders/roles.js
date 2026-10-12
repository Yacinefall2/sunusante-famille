import { and, eq, gt, isNotNull, isNull, like, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentRoles, familyMemberships, members, notifications, roleTransfers, users } from "../db/schema.js";
import { canRead, withAccess } from "../lib/documentAccess.js";
import { purgeNotificationsWithoutAccess } from "../lib/archive.js";
import { fullName, logActivity } from "../lib/activityLog.js";
import { formatDateTime } from "../lib/time.js";
import { managersOf } from "./village.js";
import { notify } from "./notify.js";

// ── Gouvernance des rôles : échéances (acteur système S1) ────────────────────
// À chaque passage du worker (engine.js runReminderTick) :
//   - Lecteur invité (R4) : 3 jours avant la fin de son accès, le lecteur ET
//     le titulaire de la fiche (sans titulaire : ses gestionnaires, ou à
//     défaut les parents) sont prévenus — une seule fois par échéance ; à
//     l'échéance, le rôle est supprimé et le journal en garde la trace.
//   - Transfert de gestion (UC-39) : une proposition restée 7 jours sans
//     réponse passe « expirée » et le proposant en est prévenu.

const DAY = 24 * 60 * 60 * 1000;
export const ROLE_EXPIRY_WARNING = 3 * DAY;
const userCols = { id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified };

// « 12/11/2026 » — date de fin d'accès lisible.
const dateOnly = (date) => formatDateTime(date).replace(/ à .*$/, "");

// Titulaire de la fiche s'il y lit le dossier, sinon ses gestionnaires
// (repli sur les parents du foyer, comme au Village).
async function ownersOf(fiche) {
  const holders = await withAccess(
    await db
      .select(userCols)
      .from(familyMemberships)
      .innerJoin(users, eq(users.id, familyMemberships.userId))
      .where(eq(familyMemberships.linkedMemberId, fiche.id)),
    fiche.id,
    canRead
  );
  if (holders.length > 0) return holders;
  return managersOf(fiche.id, fiche.familyId);
}

async function roleExpiryWarnings(now) {
  const soon = await db
    .select({ r: documentRoles, m: members, reader: userCols })
    .from(documentRoles)
    .innerJoin(members, eq(members.id, documentRoles.memberId))
    .innerJoin(users, eq(users.id, documentRoles.userId))
    .where(
      and(
        eq(documentRoles.role, "lecteur_invite"),
        isNotNull(documentRoles.expiresAt),
        gt(documentRoles.expiresAt, now),
        lte(documentRoles.expiresAt, new Date(now.getTime() + ROLE_EXPIRY_WARNING)),
        isNull(members.archivedAt)
      )
    );
  for (const { r, m, reader } of soon) {
    const until = formatDateTime(r.expiresAt);
    // Clé liée à l'échéance : une prolongation ouvre un nouvel avertissement.
    const key = `role_expiry:${r.id}:${r.expiresAt.getTime()}`;
    await notify({
      user: reader,
      category: "role_expiry",
      dedupeKey: `${key}:u${reader.id}`,
      title: `Votre accès au dossier de ${fullName(m)} prend fin bientôt`,
      body: `Accès de lecteur invité jusqu'au ${until}. Demandez au titulaire ou au gestionnaire du dossier de le prolonger si besoin.`,
      link: `/fiches?fiche=${m.id}`,
      familyId: m.familyId,
      memberId: m.id,
      now,
    });
    for (const owner of await ownersOf(m)) {
      if (owner.id === reader.id) continue;
      await notify({
        user: owner,
        category: "role_expiry",
        dedupeKey: `${key}:u${owner.id}`,
        title: `L'accès de ${reader.name} au dossier de ${fullName(m)} prend fin le ${dateOnly(r.expiresAt)}`,
        body: `Lecteur invité jusqu'au ${until}. Vous pouvez le prolonger en un clic depuis la fiche.`,
        link: `/fiches?fiche=${m.id}`,
        familyId: m.familyId,
        memberId: m.id,
        now,
      });
    }
  }
}

// Rôles de lecteur invité échus : supprimés, journalisés.
async function removeExpiredRoles(now) {
  const expired = await db
    .delete(documentRoles)
    .where(and(eq(documentRoles.role, "lecteur_invite"), isNotNull(documentRoles.expiresAt), lte(documentRoles.expiresAt, now)))
    .returning();
  for (const r of expired) {
    const [m] = await db.select().from(members).where(eq(members.id, r.memberId));
    if (!m) continue;
    await purgeNotificationsWithoutAccess(r.memberId, r.userId);
    await logActivity({
      familyId: m.familyId,
      action: "document_role_expired",
      member: m,
      target: r.userId,
      details: { expiresAt: r.expiresAt.toISOString() },
      at: now,
    });
  }
}

// Les notifications d'une proposition de transfert close sont marquées lues.
export async function readTransferNotifications(transferId, now = new Date()) {
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(isNull(notifications.readAt), like(notifications.dedupeKey, `role_transfer:${transferId}:proposed:%`)));
}

// Propositions de transfert sans réponse au bout de 7 jours : expirées.
async function expireRoleTransfers(now) {
  const expired = await db
    .update(roleTransfers)
    .set({ status: "expired", respondedAt: now })
    .where(and(eq(roleTransfers.status, "pending"), lte(roleTransfers.expiresAt, now)))
    .returning();
  for (const t of expired) {
    const [m] = await db.select().from(members).where(eq(members.id, t.memberId));
    const [from] = await db.select(userCols).from(users).where(eq(users.id, t.fromUserId));
    const [to] = await db.select(userCols).from(users).where(eq(users.id, t.toUserId));
    await readTransferNotifications(t.id, now);
    if (from) {
      await notify({
        user: from,
        category: "role_transfer",
        dedupeKey: `role_transfer:${t.id}:expired:u${from.id}`,
        title: `Votre proposition de transfert de la gestion du dossier de ${fullName(m)} a expiré`,
        body: `${to?.name ?? "La personne sollicitée"} n'a pas répondu dans les 7 jours. Vous en restez gestionnaire.`,
        link: `/fiches?fiche=${t.memberId}`,
        familyId: t.familyId,
        memberId: null,
        now,
      });
    }
    await logActivity({
      familyId: t.familyId,
      action: "role_transfer_expired",
      member: m ?? t.memberId,
      target: t.toUserId,
      details: { proposerName: from?.name ?? null },
      at: now,
    });
  }
}

export async function rolesTick(now) {
  await roleExpiryWarnings(now);
  await removeExpiredRoles(now);
  await expireRoleTransfers(now);
}
