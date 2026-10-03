import { Router } from "express";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { appointments, members, relayEvents, relayTasks, users } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { ACCESS, getFamilyAccess } from "../lib/documentAccess.js";
import { markRelayNotified, markRelayUnreachable } from "../reminders/village.js";

// Onglet Village (UC-28 à 42). Le gestionnaire (accès complet) voit tout :
// téléphone, motif, historique. Le relais ne voit que les rappels escaladés
// vers lui, avec la date, l'heure et le lieu (§4.4).
const router = Router();

const HISTORY_DAYS = 60;

router.get("/", requireFamilyMembership((req) => parseInt(req.query.familyId) || null), async (req, res) => {
  try {
    const access = await getFamilyAccess(req);
    const relatives = await db
      .select()
      .from(members)
      .where(and(eq(members.familyId, req.familyId), eq(members.status, "non_connecte")))
      .orderBy(members.id);
    const visible = relatives.filter((m) => [ACCESS.FULL, ACCESS.RELAY].includes(access.get(m.id)));
    if (visible.length === 0) return res.json([]);

    const since = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
    const tasks = await db
      .select({ t: relayTasks, a: appointments, notifiedByName: users.name })
      .from(relayTasks)
      .innerJoin(appointments, eq(appointments.id, relayTasks.appointmentId))
      .leftJoin(users, eq(users.id, relayTasks.notifiedByUserId))
      .where(and(inArray(relayTasks.memberId, visible.map((m) => m.id)), gte(relayTasks.appointmentDate, since)))
      .orderBy(desc(relayTasks.appointmentDate));
    const taskIds = tasks.map((x) => x.t.id);
    const events = taskIds.length
      ? await db
          .select({ taskId: relayEvents.taskId, type: relayEvents.type, createdAt: relayEvents.createdAt, userName: users.name })
          .from(relayEvents)
          .leftJoin(users, eq(users.id, relayEvents.userId))
          .where(inArray(relayEvents.taskId, taskIds))
          .orderBy(relayEvents.createdAt)
      : [];

    const now = Date.now();
    res.json(
      visible.map((m) => {
        const manager = access.get(m.id) === ACCESS.FULL;
        const own = tasks.filter((x) => x.t.memberId === m.id && (manager || x.t.escalatedAt));
        return {
          member: {
            id: m.id,
            firstName: m.firstName,
            lastName: m.lastName,
            avatarColor: m.avatarColor,
            ...(manager ? { phone: m.phone } : {}),
          },
          role: manager ? "manager" : "relay",
          tasks: own.map(({ t, a, notifiedByName }) => {
            const upcoming = t.appointmentDate.getTime() > now && a.status !== "cancelled" && a.appointmentDate.getTime() === t.appointmentDate.getTime();
            return {
              id: t.id,
              appointmentId: a.id,
              appointmentDate: t.appointmentDate,
              location: a.location,
              ...(manager ? { title: a.title, doctorName: a.doctorName, attendance: a.attendance, appointmentStatus: a.status } : {}),
              status: t.notifiedAt ? "notified" : upcoming ? "to_relay" : "expired",
              escalated: !!t.escalatedAt,
              notifiedAt: t.notifiedAt,
              notifiedByName,
              ...(manager ? { events: events.filter((e) => e.taskId === t.id) } : {}),
            };
          }),
        };
      })
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Charge la tâche et vérifie que le compte peut agir dessus : gestionnaire
// (accès complet à la fiche) ou relais d'une tâche escaladée.
function withTask(action) {
  return [
    async (req, res, next) => {
      try {
        const [task] = await db.select().from(relayTasks).where(eq(relayTasks.id, parseInt(req.params.id)));
        if (!task) return res.status(404).json({ error: "Rappel introuvable" });
        req.task = task;
        next();
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur serveur" });
      }
    },
    requireFamilyMembership((req) => req.task.familyId),
    async (req, res) => {
      try {
        const level = (await getFamilyAccess(req)).get(req.task.memberId);
        const isManager = level === ACCESS.FULL;
        const isRelay = level === ACCESS.RELAY && !!req.task.escalatedAt;
        if (!isManager && !isRelay) return res.status(403).json({ error: "Vous ne pouvez pas agir sur ce rappel" });
        await action(req, res);
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur serveur" });
      }
    },
  ];
}

// « Prévenu » (UC-32, UC-41) : le premier qui confirme clôt le rappel pour tous.
router.post(
  "/tasks/:id/notified",
  ...withTask(async (req, res) => {
    if (req.task.notifiedAt) {
      const [by] = await db.select({ name: users.name }).from(users).where(eq(users.id, req.task.notifiedByUserId));
      return res.status(409).json({ error: `Déjà prévenu par ${by?.name ?? "un autre membre"}` });
    }
    const closed = await markRelayNotified(req.task, req.user);
    if (!closed) return res.status(409).json({ error: "Déjà prévenu par un autre membre" });
    res.json(closed);
  })
);

// « Pas joignable » (UC-42) : alerte gestionnaires et A1, le rappel reste ouvert.
router.post(
  "/tasks/:id/unreachable",
  ...withTask(async (req, res) => {
    if (req.task.notifiedAt) return res.status(409).json({ error: "Ce rappel est déjà clos" });
    await markRelayUnreachable(req.task, req.user);
    res.json({ success: true });
  })
);

export default router;
