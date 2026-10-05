import { and, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  appointments,
  documentRoles,
  familyMemberships,
  medicationIntakes,
  members,
  notifications,
  treatmentMedications,
  treatments,
  users,
  vaccinations,
} from "../db/schema.js";
import { DELIVERY_FAILURE } from "../lib/notificationPreferences.js";
import { notify } from "./notify.js";
import { villageTick } from "./village.js";
import { sendNotificationEmail } from "../lib/mailer.js";
import { APP_TIMEZONE, addDays, formatDate, formatDateTime, localDate, zonedTime } from "../lib/time.js";

// ── Moteur de rappels et de notifications (acteur système S1, UC-54 à 56) ────
// runReminderTick() est appelé chaque minute par le service « worker ». Chaque
// étape est idempotente (clé de déduplication en base) : relancer un passage,
// ou en rater un, ne crée jamais de doublon ni de rappel perdu.

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
export const INTAKE_CATCH_UP = 2 * HOUR; // prise rattrapée si le moteur était arrêté depuis moins de 2 h
export const INTAKE_FOLLOW_UP = 30 * MINUTE; // relance unique 30 min après le rappel sans réponse
export const INTAKE_MISSED_AFTER = 12 * HOUR; // sans réponse au bout de 12 h : « sans réponse »
export const EMAIL_MAX_ATTEMPTS = 3;

const memberName = (m) => `${m.firstName} ${m.lastName}`;

// Destinataires d'un rappel pour une fiche : son titulaire (compte relié) et
// ses gestionnaires. Avec holderFirst, seulement le titulaire s'il existe
// (rappels de prise : c'est lui qui prend le médicament, adolescent compris).
async function recipientsFor(memberId, { holderFirst = false } = {}) {
  const holders = await db
    .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
    .from(familyMemberships)
    .innerJoin(users, eq(users.id, familyMemberships.userId))
    .where(eq(familyMemberships.linkedMemberId, memberId));
  if (holderFirst && holders.length > 0) return holders;
  const managers = await db
    .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
    .from(documentRoles)
    .innerJoin(users, eq(users.id, documentRoles.userId))
    .where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.role, "gestionnaire")));
  const all = new Map([...holders, ...managers].map((u) => [u.id, u]));
  return [...all.values()];
}

// ── Rendez-vous : J-3 puis J-1 (UC-54) ───────────────────────────────────────
async function appointmentReminders(now) {
  const rows = await db
    .select({ a: appointments, m: members })
    .from(appointments)
    .innerJoin(members, eq(members.id, appointments.memberId))
    .where(
      and(
        ne(appointments.status, "cancelled"),
        // Proche non connecté : rappels pris en charge par le Village (village.js)
        ne(members.status, "non_connecte"),
        gt(appointments.appointmentDate, now),
        lte(appointments.appointmentDate, new Date(now.getTime() + 72 * HOUR))
      )
    );
  for (const { a, m } of rows) {
    const remaining = a.appointmentDate.getTime() - now.getTime();
    const slot = remaining <= 24 * HOUR ? "J-1" : "J-3";
    const when = formatDateTime(a.appointmentDate);
    // Le titre donne le délai réel en jours de calendrier (un rendez-vous dans
    // 30 h est « demain », même s'il est rappelé dans la fenêtre de J-3).
    const days = Math.round(
      (Date.parse(localDate(a.appointmentDate)) - Date.parse(localDate(now))) / (24 * HOUR)
    );
    const delay = days === 0 ? "Aujourd'hui" : days === 1 ? "Demain" : `Dans ${days} jours`;
    for (const user of await recipientsFor(m.id)) {
      await notify({
        user,
        category: "appointment_reminder",
        dedupeKey: `appt:${a.id}:${a.appointmentDate.toISOString()}:${slot}:u${user.id}`,
        title: `${delay} : ${a.title} — ${memberName(m)}`,
        body: [`Le ${when}`, a.doctorName && `Avec ${a.doctorName}`, a.location && `Lieu : ${a.location}`]
          .filter(Boolean)
          .join(" · "),
        link: "/rendez-vous",
        familyId: m.familyId,
        memberId: m.id,
        now,
      });
    }
  }
}

// ── Vaccins : 7 jours avant la date du prochain rappel ───────────────────────
async function vaccineReminders(now) {
  const today = localDate(now);
  const rows = await db
    .select({ v: vaccinations, m: members })
    .from(vaccinations)
    .innerJoin(members, eq(members.id, vaccinations.memberId))
    .where(
      and(
        isNull(vaccinations.boosterDoneVaccinationId),
        sql`${vaccinations.nextDoseDate} >= ${today}`,
        sql`${vaccinations.nextDoseDate} <= ${addDays(today, 7)}`
      )
    );
  for (const { v, m } of rows) {
    for (const user of await recipientsFor(m.id)) {
      await notify({
        user,
        category: "vaccine_reminder",
        dedupeKey: `vac:${v.id}:${v.nextDoseDate}:u${user.id}`,
        title: `Rappel de vaccin : ${v.vaccineName} — ${memberName(m)}`,
        body: `Prochaine dose prévue le ${formatDate(v.nextDoseDate)}`,
        link: "/vaccinations",
        familyId: m.familyId,
        memberId: m.id,
        now,
      });
    }
  }
}

// ── Vaccins en retard : une relance 7 jours après la date prévue ─────────────
// (rappel non enregistré ; au-delà de 60 jours de retard, on ne relance plus).
export const VACCINE_LATE_AFTER_DAYS = 7;
async function lateVaccineReminders(now) {
  const today = localDate(now);
  const rows = await db
    .select({ v: vaccinations, m: members })
    .from(vaccinations)
    .innerJoin(members, eq(members.id, vaccinations.memberId))
    .where(
      and(
        isNull(vaccinations.boosterDoneVaccinationId),
        sql`${vaccinations.nextDoseDate} <= ${addDays(today, -VACCINE_LATE_AFTER_DAYS)}`,
        sql`${vaccinations.nextDoseDate} > ${addDays(today, -60)}`
      )
    );
  for (const { v, m } of rows) {
    for (const user of await recipientsFor(m.id)) {
      await notify({
        user,
        category: "vaccine_reminder",
        dedupeKey: `vac-late:${v.id}:${v.nextDoseDate}:u${user.id}`,
        title: `Rappel de vaccin en retard : ${v.vaccineName} — ${memberName(m)}`,
        body: `Prévu le ${formatDate(v.nextDoseDate)} · Pas encore enregistré : indiquez « Rappel effectué » une fois la dose faite.`,
        link: "/vaccinations",
        familyId: m.familyId,
        memberId: m.id,
        now,
      });
    }
  }
}

// ── Traitements : fin automatique à la date de fin ───────────────────────────
async function endFinishedTreatments(now) {
  await db
    .update(treatments)
    .set({ isActive: false })
    .where(and(eq(treatments.isActive, true), sql`${treatments.endDate} < ${localDate(now)}`));
}

// ── Prises de médicament : rappel à l'heure, une relance (UC-56) ─────────────
async function intakeNotification(intake, med, m, now, kind) {
  const time = new Intl.DateTimeFormat("fr-FR", { timeZone: APP_TIMEZONE, hour: "2-digit", minute: "2-digit" }).format(intake.scheduledAt);
  const what = [med.name, med.dosage].filter(Boolean).join(" ");
  for (const user of await recipientsFor(m.id, { holderFirst: true })) {
    await notify({
      user,
      category: "medication_intake",
      dedupeKey: `intake:${intake.id}:${kind}:u${user.id}`,
      title: kind === "rappel" ? `C'est l'heure : ${what}` : `Relance : ${what} (prise de ${time})`,
      body: `${memberName(m)} — prise de ${time}. Indiquez si elle a été prise.`,
      link: "/traitements",
      familyId: m.familyId,
      memberId: m.id,
      intakeId: intake.id,
      now,
    });
  }
}

async function medicationReminders(now) {
  const today = localDate(now);
  const rows = await db
    .select({ med: treatmentMedications, t: treatments, m: members })
    .from(treatmentMedications)
    .innerJoin(treatments, eq(treatments.id, treatmentMedications.treatmentId))
    .innerJoin(members, eq(members.id, treatments.memberId))
    .where(
      and(
        eq(treatments.isActive, true),
        sql`cardinality(${treatmentMedications.intakeTimes}) > 0`,
        or(isNull(treatments.startDate), sql`${treatments.startDate} <= ${today}`),
        or(isNull(treatments.endDate), sql`${treatments.endDate} >= ${today}`)
      )
    );

  for (const { med, m } of rows) {
    for (const time of med.intakeTimes) {
      const scheduledAt = zonedTime(today, time);
      if (scheduledAt > now || now.getTime() - scheduledAt.getTime() > INTAKE_CATCH_UP) continue;
      await db
        .insert(medicationIntakes)
        .values({ medicationId: med.id, memberId: m.id, scheduledAt, createdAt: now })
        .onConflictDoNothing({ target: [medicationIntakes.medicationId, medicationIntakes.scheduledAt] });
    }
  }

  // Rappel à l'heure pour chaque prise créée et pas encore rappelée.
  const toRemind = await db
    .select({ i: medicationIntakes, med: treatmentMedications, m: members })
    .from(medicationIntakes)
    .innerJoin(treatmentMedications, eq(treatmentMedications.id, medicationIntakes.medicationId))
    .innerJoin(members, eq(members.id, medicationIntakes.memberId))
    .where(and(eq(medicationIntakes.status, "pending"), isNull(medicationIntakes.remindedAt)));
  for (const { i, med, m } of toRemind) {
    await intakeNotification(i, med, m, now, "rappel");
    await db.update(medicationIntakes).set({ remindedAt: now }).where(eq(medicationIntakes.id, i.id));
  }

  // Une seule relance, 30 min après le rappel resté sans réponse.
  const toFollowUp = await db
    .select({ i: medicationIntakes, med: treatmentMedications, m: members })
    .from(medicationIntakes)
    .innerJoin(treatmentMedications, eq(treatmentMedications.id, medicationIntakes.medicationId))
    .innerJoin(members, eq(members.id, medicationIntakes.memberId))
    .where(
      and(
        eq(medicationIntakes.status, "pending"),
        isNull(medicationIntakes.followUpAt),
        lte(medicationIntakes.remindedAt, new Date(now.getTime() - INTAKE_FOLLOW_UP))
      )
    );
  for (const { i, med, m } of toFollowUp) {
    await intakeNotification(i, med, m, now, "relance");
    await db.update(medicationIntakes).set({ followUpAt: now }).where(eq(medicationIntakes.id, i.id));
  }

  await db
    .update(medicationIntakes)
    .set({ status: "missed" })
    .where(
      and(
        eq(medicationIntakes.status, "pending"),
        lte(medicationIntakes.scheduledAt, new Date(now.getTime() - INTAKE_MISSED_AFTER))
      )
    );
}

// ── Courriels : envoi, nouvelles tentatives, échec jamais silencieux (UC-66, UC-67) ──
export async function markEmailFailed(notification, reason, now = new Date()) {
  await db
    .update(notifications)
    .set({ emailStatus: "failed", emailLastError: reason, emailNextAttemptAt: null })
    .where(eq(notifications.id, notification.id));

  const [recipient] = await db.select().from(users).where(eq(users.id, notification.userId));
  const targets = [recipient];
  // L'Administrateur familial (A1) est prévenu aussi (§7.3).
  if (notification.familyId) {
    const [a1] = await db
      .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
      .from(familyMemberships)
      .innerJoin(users, eq(users.id, familyMemberships.userId))
      .where(and(eq(familyMemberships.familyId, notification.familyId), eq(familyMemberships.isPrimaryAdmin, true)));
    if (a1 && a1.id !== recipient.id) targets.push(a1);
  }
  for (const user of targets) {
    const own = user.id === recipient.id;
    await notify({
      user,
      category: DELIVERY_FAILURE,
      dedupeKey: `fail:${notification.id}:u${user.id}`,
      title: own ? "Un courriel n'a pas pu vous être remis" : `Un courriel n'a pas pu être remis à ${recipient.email}`,
      body: `« ${notification.title} » — ${reason}. ${own ? "Vérifiez votre adresse courriel." : "Vérifiez l'adresse de ce compte."}`,
      link: "/dashboard",
      familyId: notification.familyId,
      memberId: notification.memberId,
      now,
    });
  }
}

async function dispatchEmails(now, sendMail) {
  const due = await db
    .select({ n: notifications, email: users.email })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(
      and(
        eq(notifications.emailStatus, "pending"),
        or(isNull(notifications.emailNextAttemptAt), lte(notifications.emailNextAttemptAt, now))
      )
    )
    .limit(50);

  for (const { n, email } of due) {
    const attempts = n.emailAttempts + 1;
    try {
      const messageId = await sendMail({
        to: email,
        subject: `SunuSanté Famille — ${n.title}`,
        heading: n.title,
        lines: n.body ? n.body.split(" · ") : [],
        link: n.link,
      });
      await db
        .update(notifications)
        .set({ emailStatus: "sent", emailAttempts: attempts, emailSentAt: now, emailMessageId: messageId, emailLastError: null })
        .where(eq(notifications.id, n.id));
    } catch (error) {
      const reason = error?.message?.slice(0, 300) || "Erreur d'envoi";
      if (attempts >= EMAIL_MAX_ATTEMPTS) {
        await db.update(notifications).set({ emailAttempts: attempts }).where(eq(notifications.id, n.id));
        await markEmailFailed(n, reason, now);
      } else {
        await db
          .update(notifications)
          .set({
            emailAttempts: attempts,
            emailLastError: reason,
            emailNextAttemptAt: new Date(now.getTime() + attempts * 5 * MINUTE),
          })
          .where(eq(notifications.id, n.id));
      }
    }
  }
}

export async function runReminderTick({ now = new Date(), sendMail = sendNotificationEmail } = {}) {
  await appointmentReminders(now);
  await villageTick(now);
  await vaccineReminders(now);
  await lateVaccineReminders(now);
  await endFinishedTreatments(now);
  await medicationReminders(now);
  await dispatchEmails(now, sendMail);
}

// Utilisé par les routes : la réponse à une prise lit les notifications liées.
export async function markIntakeNotificationsRead(intakeId, now = new Date()) {
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.intakeId, intakeId), isNull(notifications.readAt)));
}


