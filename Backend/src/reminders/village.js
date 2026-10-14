import { and, eq, gt, isNull, like, lte, ne, sql } from "drizzle-orm";
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
import { addDays, formatDateTime, localDate, zonedTime } from "../lib/time.js";
import { canWrite, withAccess } from "../lib/documentAccess.js";
import { notify } from "./notify.js";
import { logActivity } from "../lib/activityLog.js";
import { NEXT_MORNING_TIME, REMINDER_BOUNDS, reminderSettingsCache } from "../lib/reminderSettings.js";

// ── Village : le rappel relayé vers un proche non connecté (§4) ──────────────
// J-3   : « à relayer » au(x) gestionnaire(s) — pas au patient, qui n'a pas
//         d'accès (§4.2).
// J-1   : si personne n'a marqué « Prévenu » : relance au(x) gestionnaire(s)
//         (jamais dans le même passage que la création de la tâche : au moins
//         RELAY_FOLLOW_UP_MIN_DELAY après),
// +3 h  : puis escalade vers tous les relais ; le premier « Prévenu » clôt.
//         Sans relais désigné, les gestionnaires en sont avertis.
// +12 h : une fois le rendez-vous passé de ATTENDANCE_PROMPT_AFTER, demande
//         au(x) gestionnaire(s) si le proche s'y est rendu.
// Le relais ne reçoit que la date, l'heure et le lieu (§4.4, §7.3).
// Seules les fiches « non connecté », non archivées et SANS titulaire (aucun
// compte relié) sont concernées : dès qu'un compte est relié, ce sont les
// rappels classiques qui s'appliquent.
//
// Ces délais sont les valeurs PAR DÉFAUT : chaque famille peut les régler
// (UC-08, lib/reminderSettings.js) — premier « à relayer » 2 à 7 jours avant,
// relance la veille ou 2 jours avant, escalade 1 à 12 h après la relance,
// présence demandée le soir même (12 h après) ou le lendemain à 8 h.

const HOUR = 60 * 60 * 1000;
export const ESCALATION_DELAY = 3 * HOUR;
export const ATTENDANCE_PROMPT_AFTER = 12 * HOUR;
export const RELAY_FOLLOW_UP_MIN_DELAY = 1 * HOUR;

// Instant où la présence est demandée, selon le réglage de la famille.
export function attendancePromptAt(appointmentDate, settings) {
  if (settings.attendancePrompt === "next_morning") {
    return zonedTime(addDays(localDate(appointmentDate), 1), NEXT_MORNING_TIME);
  }
  return new Date(appointmentDate.getTime() + ATTENDANCE_PROMPT_AFTER);
}

const memberName = (m) => `${m.firstName} ${m.lastName}`;
const userCols = { id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified };

// Fiche relayée : non connectée, non archivée, sans compte relié.
const relayedFiche = () =>
  and(
    eq(members.status, "non_connecte"),
    isNull(members.archivedAt),
    sql`not exists (select 1 from ${familyMemberships} where ${familyMemberships.linkedMemberId} = ${members.id})`
  );

// Gestionnaires d'une fiche ayant toujours l'accès complet (un compte devenu
// adolescent, par exemple, n'en fait plus partie).
export async function managersOf(memberId, familyId) {
  const designated = await db
    .select(userCols)
    .from(documentRoles)
    .innerJoin(users, eq(users.id, documentRoles.userId))
    // Gestionnaire suspendu par le support (UC-52) : écarté, les parents
    // prennent le relais s'il était le seul.
    .where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.role, "gestionnaire"), isNull(users.suspendedAt)));
  const managers = await withAccess(designated, memberId, canWrite);
  if (managers.length > 0) return managers;
  // Sans gestionnaire désigné, les administrateurs du foyer prennent le relais.
  return parentsOf(familyId);
}

export async function parentsOf(familyId) {
  return db
    .select(userCols)
    .from(familyMemberships)
    .innerJoin(users, eq(users.id, familyMemberships.userId))
    .where(and(eq(familyMemberships.familyId, familyId), eq(familyMemberships.role, "parent")));
}

export async function relaysOf(memberId) {
  const relays = await db
    .select(userCols)
    .from(documentRoles)
    .innerJoin(users, eq(users.id, documentRoles.userId))
    .where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.role, "relais")));
  return withAccess(relays, memberId, (level) => level !== null);
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
  // Règles de la famille (UC-08), lues une fois par passage.
  const settingsOf = reminderSettingsCache();

  // 1. J-3 (ou selon le réglage) : création des tâches et « à relayer » aux
  // gestionnaires. On lit sur la fenêtre la plus large permise, puis chaque
  // rendez-vous est filtré selon le réglage de sa famille.
  const upcoming = await db
    .select({ a: appointments, m: members })
    .from(appointments)
    .innerJoin(members, eq(members.id, appointments.memberId))
    .where(
      and(
        relayedFiche(),
        ne(appointments.status, "cancelled"),
        gt(appointments.appointmentDate, now),
        lte(appointments.appointmentDate, new Date(now.getTime() + REMINDER_BOUNDS.relayFirstDays.max * 24 * HOUR))
      )
    );
  for (const { a, m } of upcoming) {
    const settings = await settingsOf(m.familyId);
    if (a.appointmentDate.getTime() - now.getTime() > settings.relayFirstDays * 24 * HOUR) continue;
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

  // Tâches ouvertes (non « Prévenu ») d'un rendez-vous encore à venir et non
  // annulé, d'une fiche toujours relayée (toujours sans titulaire).
  const open = await db
    .select({ t: relayTasks, a: appointments, m: members })
    .from(relayTasks)
    .innerJoin(appointments, eq(appointments.id, relayTasks.appointmentId))
    .innerJoin(members, eq(members.id, relayTasks.memberId))
    .where(
      and(
        relayedFiche(),
        isNull(relayTasks.notifiedAt),
        gt(relayTasks.appointmentDate, now),
        ne(appointments.status, "cancelled"),
        eq(appointments.appointmentDate, relayTasks.appointmentDate)
      )
    );

  for (const { t, a, m } of open) {
    const remaining = t.appointmentDate.getTime() - now.getTime();
    const settings = await settingsOf(m.familyId);
    const escalationDelay = settings.escalationDelayHours * HOUR;

    // 2. J-1 (ou J-2 selon le réglage) : relance aux gestionnaires — jamais
    // dans la foulée de la création de la tâche (rendez-vous pris moins de
    // 24 h à l'avance).
    if (!t.followUpAt && remaining <= settings.followUpDaysBefore * 24 * HOUR) {
      if (now.getTime() - t.createdAt.getTime() < RELAY_FOLLOW_UP_MIN_DELAY) continue;
      await db.update(relayTasks).set({ followUpAt: now }).where(eq(relayTasks.id, t.id));
      await logRelayEvent(t.id, "follow_up", null, now);
      await notifyMany(
        await managersOf(m.id, m.familyId),
        {
          category: "relay_to_relay",
          title: `Relance : ${memberName(m)} n'est pas encore prévenu`,
          body: [whereLine(a), `Sans « Prévenu » d'ici ${settings.escalationDelayHours} h, les relais seront sollicités.`].join(" · "),
          link: "/village",
          familyId: m.familyId,
          memberId: m.id,
          now,
        },
        `relay:${t.id}:follow_up`
      );
      continue;
    }

    // 3. +3 h (ou le délai réglé, ou à 2 h du rendez-vous) : escalade vers tous les relais.
    const followUpAge = t.followUpAt ? now.getTime() - t.followUpAt.getTime() : 0;
    if (t.followUpAt && !t.escalatedAt && (followUpAge >= escalationDelay || remaining <= 2 * HOUR)) {
      await db.update(relayTasks).set({ escalatedAt: now }).where(eq(relayTasks.id, t.id));
      const relays = await relaysOf(m.id);
      if (relays.length === 0) {
        // Personne vers qui escalader : les gestionnaires doivent le savoir
        // (sinon le rappel s'éteindrait en silence).
        await logRelayEvent(t.id, "no_relay", null, now);
        await notifyMany(
          await managersOf(m.id, m.familyId),
          {
            category: "relay_alert",
            title: `Aucun relais désigné pour prévenir ${memberName(m)}`,
            body: [whereLine(a), "Il faut encore le prévenir : appelez-le ou désignez un relais."].join(" · "),
            link: "/village",
            familyId: m.familyId,
            memberId: m.id,
            now,
          },
          `relay:${t.id}:no_relay`
        );
        continue;
      }
      await logRelayEvent(t.id, "escalated", null, now);
      // Cloisonnement : date, heure et lieu seulement — objet neutre (§4.4, §7.3).
      await notifyMany(
        relays,
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

  // 4. Rendez-vous passé de 12 h (« le soir même », par défaut) ou lendemain
  // 8 h (« le lendemain matin ») : présence demandée une fois aux gestionnaires.
  const past = await db
    .select({ t: relayTasks, a: appointments, m: members })
    .from(relayTasks)
    .innerJoin(appointments, eq(appointments.id, relayTasks.appointmentId))
    .innerJoin(members, eq(members.id, relayTasks.memberId))
    .where(
      and(
        relayedFiche(),
        isNull(relayTasks.attendancePromptAt),
        isNull(appointments.attendance),
        ne(appointments.status, "cancelled"),
        eq(appointments.appointmentDate, relayTasks.appointmentDate),
        lte(relayTasks.appointmentDate, now)
      )
    );
  for (const { t, a, m } of past) {
    if (attendancePromptAt(t.appointmentDate, await settingsOf(m.familyId)) > now) continue;
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
export async function readTaskNotifications(taskId, now = new Date()) {
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(isNull(notifications.readAt), like(notifications.dedupeKey, `relay:${taskId}:%`)));
}

// Tâche périmée : rendez-vous passé, annulé ou déplacé depuis sa création.
// On ne peut plus y répondre « Prévenu » ni « Pas joignable ».
export function isTaskStale(task, appointment, now = new Date()) {
  return (
    !appointment ||
    task.appointmentDate.getTime() <= now.getTime() ||
    appointment.status === "cancelled" ||
    appointment.appointmentDate.getTime() !== task.appointmentDate.getTime()
  );
}

// Rendez-vous d'un proche annulé, déplacé ou supprimé (routes/appointments.js) :
// la tâche Village de l'ancienne date est close (événement « cancelled » ou
// « moved »), ses notifications « à relayer » sont marquées lues, et les
// gestionnaires — ainsi que les relais déjà sollicités et la personne qui a
// prévenu le proche — sont informés. Message neutre (date, heure, lieu),
// comme tout ce qui part vers un relais (§4.4). `after` : le rendez-vous
// modifié, ou null s'il est supprimé.
export async function onAppointmentChanged(before, after, actorUserId = null, now = new Date()) {
  const cancelled = !after || after.status === "cancelled";
  const tasks = await db
    .select()
    .from(relayTasks)
    .where(
      and(
        eq(relayTasks.appointmentId, before.id),
        eq(relayTasks.appointmentDate, before.appointmentDate),
        gt(relayTasks.appointmentDate, now)
      )
    );
  for (const t of tasks) {
    const [m] = await db.select().from(members).where(eq(members.id, t.memberId));
    if (!m || m.archivedAt) continue;
    await logRelayEvent(t.id, cancelled ? "cancelled" : "moved", actorUserId, now);
    await readTaskNotifications(t.id, now);

    const targets = new Map((await managersOf(m.id, m.familyId)).map((u) => [u.id, u]));
    if (t.escalatedAt) for (const u of await relaysOf(m.id)) targets.set(u.id, u);
    if (t.notifiedByUserId && !targets.has(t.notifiedByUserId)) {
      const [by] = await db.select(userCols).from(users).where(eq(users.id, t.notifiedByUserId));
      if (by && (await withAccess([by], m.id, (level) => level !== null)).length) targets.set(by.id, by);
    }
    if (actorUserId) targets.delete(actorUserId);

    const was = whereLine(before);
    await notifyMany(
      [...targets.values()],
      {
        category: "relay_update",
        title: cancelled ? `Rendez-vous de ${memberName(m)} annulé` : `Rendez-vous de ${memberName(m)} déplacé`,
        body: cancelled
          ? [`Rendez-vous annulé : ${was}`, t.notifiedAt ? "Pensez à le prévenir de l'annulation." : null].filter(Boolean).join(" · ")
          : [`Ancienne date : ${formatDateTime(before.appointmentDate)}`, `Nouvelle date : ${whereLine(after)}`].join(" · "),
        link: "/village",
        familyId: m.familyId,
        memberId: m.id,
        now,
      },
      `relaychange:${t.id}:${cancelled ? "cancelled" : `moved:${after.appointmentDate.toISOString()}`}`
    );
  }
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
  await logActivity({
    familyId: task.familyId,
    actor: user,
    action: "relay_notified",
    member: task.memberId,
    details: { taskId: task.id, appointmentDate: task.appointmentDate },
    at: now,
  });
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
// sont alertés tout de suite. Une seule alerte par personne, par tâche et par
// heure : marquer « Pas joignable » plusieurs fois de suite ne multiplie pas
// les alertes.
export async function markRelayUnreachable(task, user, now = new Date()) {
  await logRelayEvent(task.id, "unreachable", user.id, now);
  await logActivity({
    familyId: task.familyId,
    actor: user,
    action: "relay_unreachable",
    member: task.memberId,
    details: { taskId: task.id, appointmentDate: task.appointmentDate },
    at: now,
  });
  const [m] = await db.select().from(members).where(eq(members.id, task.memberId));
  const targets = new Map((await managersOf(task.memberId, task.familyId)).map((u) => [u.id, u]));
  const a1 = await primaryAdminOf(task.familyId);
  if (a1) targets.set(a1.id, a1);
  targets.delete(user.id);
  const hour = Math.floor(now.getTime() / HOUR);
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
    `relay:${task.id}:unreachable:${user.id}:h${hour}`
  );
}
