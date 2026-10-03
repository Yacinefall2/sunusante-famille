import { and, eq, gt, isNull, like, lte, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  appointments,
  documentRoles,
  familyMemberships,
  members,
  notifications,
  relayEvents,
  relayTasks,
  users,
} from "../db/schema.js";
import { formatDateTime } from "../lib/time.js";
import { notify } from "./notify.js";

// ── Village : le rappel relayé vers un proche non connecté (§4) ──────────────
// J-3  : « à relayer » au(x) gestionnaire(s) — pas au patient, qui n'a pas
//        d'accès (§4.2).
// J-1  : si personne n'a marqué « Prévenu » : relance au(x) gestionnaire(s),
// +3 h : puis escalade vers tous les relais ; le premier « Prévenu » clôt.
// J+1  : demande au(x) gestionnaire(s) si le proche s'est rendu au rendez-vous.
// Le relais ne reçoit que la date, l'heure et le lieu (§4.4, §7.3).

const HOUR = 60 * 60 * 1000;
export const ESCALATION_DELAY = 3 * HOUR;
export const ATTENDANCE_PROMPT_AFTER = 12 * HOUR;

const memberName = (m) => `${m.firstName} ${m.lastName}`;
const userCols = { id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified };

export async function managersOf(memberId, familyId) {
  const managers = await db
    .select(userCols)
    .from(documentRoles)
    .innerJoin(users, eq(users.id, documentRoles.userId))
    .where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.role, "gestionnaire")));
  if (managers.length > 0) return managers;
  // Sans gestionnaire désigné, les administrateurs du foyer prennent le relais.
  return db
    .select(userCols)
    .from(familyMemberships)
    .innerJoin(users, eq(users.id, familyMemberships.userId))
    .where(and(eq(familyMemberships.familyId, familyId), eq(familyMemberships.role, "parent")));
}

export async function relaysOf(memberId) {
  return db
    .select(userCols)
    .from(documentRoles)
    .innerJoin(users, eq(users.id, documentRoles.userId))
    .where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.role, "relais")));
}

async function primaryAdminOf(familyId) {
  const [a1] = await db
    .select(userCols)
    .from(familyMemberships)
    .innerJoin(users, eq(users.id, familyMemberships.userId))
    .where(and(eq(familyMemberships.familyId, familyId), eq(familyMemberships.isPrimaryAdmin, true)));
  return a1 ?? null;
}

export async function logRelayEvent(taskId, type, userId = null, now = new Date()) {
  await db.insert(relayEvents).values({ taskId, type, userId, createdAt: now });
}

const whereLine = (a) => [`Le ${formatDateTime(a.appointmentDate)}`, a.location && `Lieu : ${a.location}`].filter(Boolean).join(" · ");

async function notifyMany(users, base, keyPrefix) {
  for (const user of users) await notify({ ...base, user, dedupeKey: `${keyPrefix}:u${user.id}` });
}

export async function villageTick(now) {
  // 1. J-3 : création des tâches et « à relayer » aux gestionnaires.
  const upcoming = await db
    .select({ a: appointments, m: members })
    .from(appointments)
    .innerJoin(members, eq(members.id, appointments.memberId))
    .where(
      and(
        eq(members.status, "non_connecte"),
        ne(appointments.status, "cancelled"),
        gt(appointments.appointmentDate, now),
        lte(appointments.appointmentDate, new Date(now.getTime() + 72 * HOUR))
      )
    );
  for (const { a, m } of upcoming) {
    const [task] = await db
      .insert(relayTasks)
      .values({ appointmentId: a.id, memberId: m.id, familyId: m.familyId, appointmentDate: a.appointmentDate, createdAt: now })
      .onConflictDoNothing({ target: [relayTasks.appointmentId, relayTasks.appointmentDate] })
      .returning();
    if (!task) continue;
    await logRelayEvent(task.id, "to_relay", null, now);
    await notifyMany(
      await managersOf(m.id, m.familyId),
      {
        category: "relay_to_relay",
        title: `À relayer : prévenir ${memberName(m)} de son rendez-vous`,
        body: [whereLine(a), a.title && `Motif : ${a.title}`, "Appelez-le, puis marquez « Prévenu »."].filter(Boolean).join(" · "),
        link: "/village",
        familyId: m.familyId,
        memberId: m.id,
        now,
      },
      `relay:${task.id}:to_relay`
    );
  }

  // Tâches ouvertes (non « Prévenu ») d'un rendez-vous encore à venir et non annulé.
  const open = await db
    .select({ t: relayTasks, a: appointments, m: members })
    .from(relayTasks)
    .innerJoin(appointments, eq(appointments.id, relayTasks.appointmentId))
    .innerJoin(members, eq(members.id, relayTasks.memberId))
    .where(
      and(
        isNull(relayTasks.notifiedAt),
        gt(relayTasks.appointmentDate, now),
        ne(appointments.status, "cancelled"),
        eq(appointments.appointmentDate, relayTasks.appointmentDate)
      )
    );

  for (const { t, a, m } of open) {
    const remaining = t.appointmentDate.getTime() - now.getTime();

    // 2. J-1 : relance aux gestionnaires.
    if (!t.followUpAt && remaining <= 24 * HOUR) {
      await db.update(relayTasks).set({ followUpAt: now }).where(eq(relayTasks.id, t.id));
      await logRelayEvent(t.id, "follow_up", null, now);
      await notifyMany(
        await managersOf(m.id, m.familyId),
        {
          category: "relay_to_relay",
          title: `Relance : ${memberName(m)} n'est pas encore prévenu`,
          body: [whereLine(a), "Sans « Prévenu » d'ici 3 h, les relais seront sollicités."].join(" · "),
          link: "/village",
          familyId: m.familyId,
          memberId: m.id,
          now,
        },
        `relay:${t.id}:follow_up`
      );
      continue;
    }

    // 3. +3 h (ou à 2 h du rendez-vous) : escalade vers tous les relais.
    const followUpAge = t.followUpAt ? now.getTime() - t.followUpAt.getTime() : 0;
    if (t.followUpAt && !t.escalatedAt && (followUpAge >= ESCALATION_DELAY || remaining <= 2 * HOUR)) {
      await db.update(relayTasks).set({ escalatedAt: now }).where(eq(relayTasks.id, t.id));
      await logRelayEvent(t.id, "escalated", null, now);
      // Cloisonnement : date, heure et lieu seulement — objet neutre (§4.4, §7.3).
      await notifyMany(
        await relaysOf(m.id),
        {
          category: "relay_escalation",
          title: "Un rappel à relayer",
          body: [`Prévenir ${memberName(m)}`, whereLine(a)].join(" · "),
          link: "/village",
          familyId: m.familyId,
          memberId: m.id,
          now,
        },
        `relay:${t.id}:escalated`
      );
    }
  }

  // 4. J+1 : présence au rendez-vous, demandée une fois aux gestionnaires.
  const past = await db
    .select({ t: relayTasks, a: appointments, m: members })
    .from(relayTasks)
    .innerJoin(appointments, eq(appointments.id, relayTasks.appointmentId))
    .innerJoin(members, eq(members.id, relayTasks.memberId))
    .where(
      and(
        isNull(relayTasks.attendancePromptAt),
        isNull(appointments.attendance),
        ne(appointments.status, "cancelled"),
        eq(appointments.appointmentDate, relayTasks.appointmentDate),
        lte(relayTasks.appointmentDate, new Date(now.getTime() - ATTENDANCE_PROMPT_AFTER))
      )
    );
  for (const { t, a, m } of past) {
    await db.update(relayTasks).set({ attendancePromptAt: now }).where(eq(relayTasks.id, t.id));
    await notifyMany(
      await managersOf(m.id, m.familyId),
      {
        category: "relay_update",
        title: `${memberName(m)} s'est-il rendu à son rendez-vous ?`,
        body: [whereLine(a), "Indiquez-le dans le Village."].join(" · "),
        link: "/village",
        familyId: m.familyId,
        memberId: m.id,
        now,
      },
      `relay:${t.id}:attendance`
    );
  }
}

// Les notifications « à relayer » d'une tâche close sont marquées lues pour tous.
async function readTaskNotifications(taskId, now) {
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(isNull(notifications.readAt), like(notifications.dedupeKey, `relay:${taskId}:%`)));
}

// « Prévenu » : clôt la tâche pour tout le monde. Si c'est un relais qui a
// prévenu, les gestionnaires en sont informés.
export async function markRelayNotified(task, user, now = new Date()) {
  const [closed] = await db
    .update(relayTasks)
    .set({ notifiedAt: now, notifiedByUserId: user.id })
    .where(and(eq(relayTasks.id, task.id), isNull(relayTasks.notifiedAt)))
    .returning();
  if (!closed) return null; // déjà clos par quelqu'un d'autre
  await logRelayEvent(task.id, "notified", user.id, now);
  await readTaskNotifications(task.id, now);
  const managers = await managersOf(task.memberId, task.familyId);
  if (!managers.some((u) => u.id === user.id)) {
    const [m] = await db.select().from(members).where(eq(members.id, task.memberId));
    await notifyMany(
      managers,
      {
        category: "relay_update",
        title: `${user.name} a prévenu ${memberName(m)}`,
        body: `Rendez-vous du ${formatDateTime(task.appointmentDate)}`,
        link: "/village",
        familyId: task.familyId,
        memberId: task.memberId,
        now,
      },
      `relay:${task.id}:notified_by:${user.id}`
    );
  }
  return closed;
}

// « Pas joignable » (UC-42) : la tâche reste ouverte ; gestionnaires et A1
// sont alertés tout de suite.
export async function markRelayUnreachable(task, user, now = new Date()) {
  await logRelayEvent(task.id, "unreachable", user.id, now);
  const [m] = await db.select().from(members).where(eq(members.id, task.memberId));
  const targets = new Map((await managersOf(task.memberId, task.familyId)).map((u) => [u.id, u]));
  const a1 = await primaryAdminOf(task.familyId);
  if (a1) targets.set(a1.id, a1);
  targets.delete(user.id);
  await notifyMany(
    [...targets.values()],
    {
      category: "relay_alert",
      title: `${user.name} n'a pas pu joindre ${memberName(m)}`,
      body: `Rendez-vous du ${formatDateTime(task.appointmentDate)} · Il faut encore le prévenir.`,
      link: "/village",
      familyId: task.familyId,
      memberId: task.memberId,
      now,
    },
    `relay:${task.id}:unreachable:${user.id}:${now.getTime()}`
  );
}

