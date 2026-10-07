import { Router } from "express";
import { and, eq, gte, inArray, isNull, lte, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  appointments,
  documents,
  familyMemberships,
  medicationIntakes,
  members,
  notifications,
  pendingInvitations,
  relayEvents,
  relayTasks,
  treatmentMedications,
  treatments,
  users,
  vaccinations,
} from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { canSeeDocument, readableMemberIds } from "../lib/documentAccess.js";
import { ageOn } from "../lib/family.js";
import { APP_TIMEZONE, addDays, localDate, zonedTime } from "../lib/time.js";
import { boosterStatus } from "./vaccinations.js";

// ── Tableau de bord des parents : tout ce qui se passe dans la famille ───────
// Réservé aux administrateurs (A1/A2). Il couvre toutes les fiches qu'ils
// peuvent lire — tout le foyer, sauf la fiche de l'autre parent (§10), qui
// apparaît seulement comme « dossier privé ». La spécification limite le
// tableau de bord aux dossiers gérés « pour ne pas noyer l'utilisateur » :
// c'est un filtre d'affichage, élargi ici pour les parents à leur demande.
const router = Router();

const DAY = 24 * 60 * 60 * 1000;
const fullName = (m) => `${m.firstName} ${m.lastName}`;
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);

router.get(
  "/",
  requireFamilyMembership((req) => parseInt(req.query.familyId) || null, { roles: ["parent"] }),
  async (req, res) => {
    try {
      const now = new Date();
      const today = localDate(now);
      const dayStart = zonedTime(today, "00:00");
      const dayEnd = new Date(dayStart.getTime() + DAY);
      const since30 = new Date(now.getTime() - 30 * DAY);

      const all = await db.select().from(members).where(eq(members.familyId, req.familyId)).orderBy(members.dateOfBirth);
      const readable = new Set(await readableMemberIds(req));
      const ids = [...readable];
      const byId = new Map(all.map((m) => [m.id, m]));
      const name = (id) => (byId.get(id) ? fullName(byId.get(id)) : "");
      const accounts = await db
        .select({ userId: users.id, name: users.name, role: familyMemberships.role, isPrimaryAdmin: familyMemberships.isPrimaryAdmin, linkedMemberId: familyMemberships.linkedMemberId })
        .from(familyMemberships)
        .innerJoin(users, eq(users.id, familyMemberships.userId))
        .where(eq(familyMemberships.familyId, req.familyId));
      const accountByFiche = new Map(accounts.filter((a) => a.linkedMemberId).map((a) => [a.linkedMemberId, a]));

      const none = ids.length === 0;
      const inFiches = (col) => (none ? eq(col, -1) : inArray(col, ids));

      // ── Données de base (fiches lisibles uniquement) ──
      const appts = await db.select().from(appointments).where(and(inFiches(appointments.memberId), gte(appointments.appointmentDate, since30)));
      const intakes = await db
        .select({ i: medicationIntakes, name: treatmentMedications.name, dosage: treatmentMedications.dosage, treatmentId: treatmentMedications.treatmentId })
        .from(medicationIntakes)
        .innerJoin(treatmentMedications, eq(treatmentMedications.id, medicationIntakes.medicationId))
        .where(and(inFiches(medicationIntakes.memberId), gte(medicationIntakes.scheduledAt, since30)));
      const activeTreatments = await db.select().from(treatments).where(and(inFiches(treatments.memberId), eq(treatments.isActive, true)));
      const meds = activeTreatments.length
        ? await db.select().from(treatmentMedications).where(inArray(treatmentMedications.treatmentId, activeTreatments.map((t) => t.id)))
        : [];
      const vaccs = (await db.select().from(vaccinations).where(inFiches(vaccinations.memberId))).map((v) => ({ ...v, boosterStatus: boosterStatus(v, today) }));
      const openRelays = await db
        .select()
        .from(relayTasks)
        .where(and(eq(relayTasks.familyId, req.familyId), inFiches(relayTasks.memberId), isNull(relayTasks.notifiedAt), gt(relayTasks.appointmentDate, now)));
      const relayHistory = await db
        .select()
        .from(relayTasks)
        .where(and(eq(relayTasks.familyId, req.familyId), inFiches(relayTasks.memberId), gte(relayTasks.appointmentDate, since30), lte(relayTasks.appointmentDate, now)));

      // ── 1. À traiter, du plus urgent au moins urgent ──
      const todo = [];
      const push = (item) => todo.push(item);
      for (const { i, name: med, dosage } of intakes) {
        const scheduled = i.scheduledAt;
        if (scheduled < dayStart || scheduled >= dayEnd) continue;
        if (i.status === "missed" || (i.status === "pending" && scheduled <= now)) {
          const time = new Intl.DateTimeFormat("fr-FR", { timeZone: APP_TIMEZONE, hour: "2-digit", minute: "2-digit" }).format(scheduled);
          push({
            type: "intake",
            severity: i.status === "missed" ? "alert" : "warn",
            memberId: i.memberId,
            title: `${name(i.memberId)} — ${[med, dosage].filter(Boolean).join(" ")} de ${time}`,
            detail: i.status === "missed" ? "Prise sans réponse" : "Prise non confirmée",
            action: { kind: "intake", id: i.id },
            link: "/traitements",
          });
        }
      }
      for (const v of vaccs.filter((x) => x.boosterStatus === "en_retard")) {
        push({ type: "vaccine", severity: "alert", memberId: v.memberId, title: `${name(v.memberId)} — rappel ${v.vaccineName} en retard`, detail: `Prévu le ${v.nextDoseDate}`, action: { kind: "booster", id: v.id }, link: "/vaccinations" });
      }
      const unreachable = openRelays.length
        ? await db.select().from(relayEvents).where(and(inArray(relayEvents.taskId, openRelays.map((t) => t.id)), eq(relayEvents.type, "unreachable")))
        : [];
      for (const t of openRelays) {
        const failed = unreachable.some((e) => e.taskId === t.id);
        push({
          type: "relay",
          severity: failed ? "alert" : "warn",
          memberId: t.memberId,
          title: `Prévenir ${name(t.memberId)} de son rendez-vous`,
          detail: failed ? "Un relais n'a pas pu le joindre" : t.escalatedAt ? "Les relais ont été sollicités" : "À relayer",
          action: { kind: "village", id: t.id },
          link: "/village",
        });
      }
      for (const a of appts.filter((x) => x.appointmentDate < now && x.status !== "cancelled" && !x.attendance)) {
        push({ type: "attendance", severity: "warn", memberId: a.memberId, title: `${name(a.memberId)} — ${a.title}`, detail: "Rendez-vous passé : présence à indiquer", action: { kind: "attendance", id: a.id }, link: "/rendez-vous" });
      }
      for (const m of all.filter((x) => readable.has(x.id) && (!x.kinship || !x.gender || !x.dateOfBirth))) {
        push({ type: "fiche", severity: "warn", memberId: m.id, title: `Fiche de ${fullName(m)} à compléter`, detail: "Lien, âge ou sexe manquant", action: { kind: "edit", id: m.id }, link: `/fiches?fiche=${m.id}&modifier=1` });
      }
      const failures = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, req.user.id), eq(notifications.category, "delivery_failure"), isNull(notifications.readAt)));
      for (const n of failures) {
        push({ type: "delivery", severity: "alert", memberId: n.memberId, title: n.title, detail: n.body, action: null, link: "/notifications" });
      }
      const invitations = await db
        .select()
        .from(pendingInvitations)
        .where(and(eq(pendingInvitations.familyId, req.familyId), isNull(pendingInvitations.acceptedAt), gt(pendingInvitations.expiresAt, now)));
      for (const inv of invitations) {
        push({ type: "invitation", severity: "info", memberId: inv.linkedMemberId, title: `Invitation en attente : ${inv.email}`, detail: `Expire le ${localDate(inv.expiresAt)}`, action: null, link: "/famille" });
      }
      const rank = { alert: 0, warn: 1, info: 2 };
      todo.sort((a, b) => rank[a.severity] - rank[b.severity]);

      // ── 2. Agenda : aujourd'hui et les 7 prochains jours ──
      const weekEnd = new Date(dayStart.getTime() + 8 * DAY);
      const agenda = {
        appointments: appts
          .filter((a) => a.appointmentDate >= dayStart && a.appointmentDate < weekEnd && a.status !== "cancelled")
          .sort((a, b) => a.appointmentDate - b.appointmentDate)
          .map((a) => ({ id: a.id, memberId: a.memberId, memberName: name(a.memberId), title: a.title, doctorName: a.doctorName, location: a.location, appointmentDate: a.appointmentDate, status: a.status })),
        intakesToday: intakes
          .filter(({ i }) => i.scheduledAt >= dayStart && i.scheduledAt < dayEnd)
          .sort((a, b) => a.i.scheduledAt - b.i.scheduledAt)
          .map(({ i, name: med, dosage }) => ({ id: i.id, memberId: i.memberId, memberName: name(i.memberId), medication: [med, dosage].filter(Boolean).join(" "), scheduledAt: i.scheduledAt, status: i.status })),
        vaccinesSoon: vaccs
          .filter((v) => v.boosterStatus === "a_faire" && v.nextDoseDate <= addDays(today, 30))
          .sort((a, b) => (a.nextDoseDate < b.nextDoseDate ? -1 : 1))
          .map((v) => ({ id: v.id, memberId: v.memberId, memberName: name(v.memberId), vaccineName: v.vaccineName, nextDoseDate: v.nextDoseDate })),
      };

      // ── 3. Une carte par membre, avec voyant ──
      const adherence = (rows) => {
        const answered = rows.filter(({ i }) => ["taken", "not_taken", "missed"].includes(i.status));
        const taken = answered.filter(({ i }) => i.status === "taken").length;
        return { taken, total: answered.length, pct: pct(taken, answered.length) };
      };
      const memberCards = all.map((m) => {
        const account = accountByFiche.get(m.id);
        const base = { id: m.id, firstName: m.firstName, lastName: m.lastName, avatarColor: m.avatarColor, gender: m.gender, dateOfBirth: m.dateOfBirth, kinship: m.kinship, kinshipRelatedMemberId: m.kinshipRelatedMemberId, status: m.status, age: ageOn(m.dateOfBirth), account: account ? { name: account.name, role: account.role, isPrimaryAdmin: account.isPrimaryAdmin } : null };
        if (!readable.has(m.id)) return { ...base, private: true, light: null };
        const items = todo.filter((t) => t.memberId === m.id);
        const memberTreatments = activeTreatments
          .filter((t) => t.memberId === m.id)
          .map((t) => ({ id: t.id, disease: t.disease, medications: meds.filter((x) => x.treatmentId === t.id).map((x) => x.name), adherence: adherence(intakes.filter((x) => x.treatmentId === t.id)) }));
        // Traitement mal suivi sur 30 jours (moins de 50 %, au moins 3 prises
        // connues) : voyant orange, même si rien n'est à faire aujourd'hui.
        const poorlyFollowed = memberTreatments
          .filter((t) => t.adherence.total >= 3 && t.adherence.pct < 50)
          .map((t) => `Prises peu suivies : ${t.disease} (${t.adherence.pct} %)`);
        const next = appts.filter((a) => a.memberId === m.id && a.appointmentDate >= now && a.status !== "cancelled").sort((a, b) => a.appointmentDate - b.appointmentDate)[0];
        const nextVaccine = vaccs.filter((v) => v.memberId === m.id && v.boosterStatus && v.boosterStatus !== "fait").sort((a, b) => (a.nextDoseDate < b.nextDoseDate ? -1 : 1))[0];
        return {
          ...base,
          private: false,
          light: items.some((t) => t.severity === "alert") ? "red" : items.some((t) => t.severity === "warn") || poorlyFollowed.length ? "orange" : "green",
          alerts: [...items.map((t) => t.detail), ...poorlyFollowed],
          nextAppointment: next ? { title: next.title, appointmentDate: next.appointmentDate, location: next.location } : null,
          treatments: memberTreatments,
          nextVaccine: nextVaccine ? { vaccineName: nextVaccine.vaccineName, nextDoseDate: nextVaccine.nextDoseDate, boosterStatus: nextVaccine.boosterStatus } : null,
        };
      });

      // ── 4. Indicateurs de la famille sur 30 jours (§4.3) ──
      const pastAppts = appts.filter((a) => a.appointmentDate < now && a.status !== "cancelled");
      const attended = pastAppts.filter((a) => a.attendance === "attended").length;
      const answeredAppts = pastAppts.filter((a) => a.attendance).length;
      const boosters = vaccs.filter((v) => v.boosterStatus);
      const relaysOnTime = relayHistory.filter((t) => t.notifiedAt && t.notifiedAt <= t.appointmentDate).length;
      const indicators = {
        intakes: adherence(intakes),
        appointments: { attended, answered: answeredAppts, unanswered: pastAppts.length - answeredAppts, pct: pct(attended, answeredAppts) },
        vaccines: { upToDate: boosters.filter((v) => v.boosterStatus !== "en_retard").length, total: boosters.length, late: boosters.filter((v) => v.boosterStatus === "en_retard").length },
        relays: { onTime: relaysOnTime, total: relayHistory.length, pct: pct(relaysOnTime, relayHistory.length) },
      };

      // ── 5. Activité récente (qui a fait quoi) ──
      const userName = new Map(accounts.map((a) => [a.userId, a.name]));
      const activity = [];
      const docs = await db.select().from(documents).where(and(inFiches(documents.memberId), gte(documents.uploadedAt, since30)));
      for (const d of docs.filter((x) => canSeeDocument(req, x))) {
        activity.push({ at: d.uploadedAt, kind: "document", memberId: d.memberId, text: `Document ajouté pour ${name(d.memberId)} : ${d.title}`, by: userName.get(d.uploadedByUserId) ?? null });
      }
      for (const { i, name: med } of intakes.filter(({ i }) => i.respondedAt)) {
        activity.push({ at: i.respondedAt, kind: "intake", memberId: i.memberId, text: `${med} de ${name(i.memberId)} : ${i.status === "taken" ? "pris" : "pas pris"}`, by: userName.get(i.respondedByUserId) ?? null });
      }
      for (const a of appts.filter((x) => x.createdAt >= since30)) {
        activity.push({ at: a.createdAt, kind: "appointment", memberId: a.memberId, text: `Rendez-vous ajouté pour ${name(a.memberId)} : ${a.title}`, by: null });
      }
      const relayTaskIds = [...openRelays, ...relayHistory].map((t) => t.id);
      if (relayTaskIds.length) {
        const evs = await db.select().from(relayEvents).where(and(inArray(relayEvents.taskId, relayTaskIds), inArray(relayEvents.type, ["notified", "unreachable"])));
        const taskMember = new Map([...openRelays, ...relayHistory].map((t) => [t.id, t.memberId]));
        for (const e of evs) {
          const who = name(taskMember.get(e.taskId));
          activity.push({ at: e.createdAt, kind: "relay", memberId: taskMember.get(e.taskId), text: e.type === "notified" ? `${who} a été prévenu de son rendez-vous` : `${who} n'a pas pu être joint`, by: userName.get(e.userId) ?? null });
        }
      }
      activity.sort((a, b) => b.at - a.at);

      res.json({
        today,
        counts: { members: all.length, accounts: accounts.length, readable: readable.size },
        todo,
        agenda,
        members: memberCards,
        indicators,
        activity: activity.slice(0, 15),
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;
