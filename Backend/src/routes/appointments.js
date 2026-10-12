import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { appointments, relayTasks } from "../db/schema.js";
import { logRelayEvent, onAppointmentChanged } from "../reminders/village.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdForListQuery, familyIdFromMemberId, familyIdFromResource } from "../lib/familyResolvers.js";
import { ACCESS, canRead, canWriteMember, getFamilyAccess } from "../lib/documentAccess.js";
import { INVALID_DATETIME, INVALID_ID, parseDateTime, parseId, tooLong } from "../lib/validation.js";

const router = Router();

router.get("/", requireFamilyMembership(familyIdForListQuery), async (req, res) => {
  try {
    // Fiches lisibles (dossier complet) + fiches dont on est Relais : pour
    // celles-ci, seuls la date, l'heure, le lieu et le statut (un relais doit
    // savoir qu'un rendez-vous est annulé) sont renvoyés (§4.4) — ni le
    // titre, ni le praticien, ni les notes, ni la présence.
    const access = await getFamilyAccess(req);
    const visible = (id) => canRead(access.get(id)) || access.get(id) === ACCESS.RELAY;
    let memberIds;
    if (req.query.memberId) {
      const id = parseId(req.query.memberId);
      if (!id || !visible(id)) return res.status(403).json({ error: "Accès refusé à ce dossier" });
      memberIds = [id];
    } else {
      memberIds = [...access.keys()].filter(visible);
    }
    if (memberIds.length === 0) return res.json([]);

    const rows = await db
      .select()
      .from(appointments)
      .where(inArray(appointments.memberId, memberIds))
      .orderBy(appointments.appointmentDate);
    res.json(
      rows.map((a) =>
        canRead(access.get(a.memberId))
          ? a
          : { id: a.id, memberId: a.memberId, appointmentDate: a.appointmentDate, location: a.location, status: a.status, restricted: true }
      )
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Statut (M3) et présence une fois la date passée (UC-18, UC-33).
const STATUSES = ["pending", "confirmed", "cancelled"];
const ATTENDANCES = ["attended", "missed"];

const optionalText = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

// Longueurs maximales (varchar de db/schema.js).
const tooLongAppointment = (v) =>
  tooLong([
    [v.title, 255, "Titre"],
    [v.doctorName, 255, "Praticien"],
    [v.location, 255, "Lieu"],
  ]);

// Valide la présence demandée pour un rendez-vous à la date `date` et au
// statut `status`. Renvoie { value } ou { error }. La présence ne se renseigne
// que pour un rendez-vous passé (ou en cours) et non annulé.
function resolveAttendance(attendance, date, status) {
  if (attendance === undefined || attendance === null || attendance === "") return { value: null };
  if (!ATTENDANCES.includes(attendance)) return { error: "Présence invalide" };
  if (status === "cancelled") return { error: "Un rendez-vous annulé n'a pas de présence à renseigner" };
  if (new Date(date) > new Date()) return { error: "La présence se renseigne une fois le rendez-vous passé" };
  return { value: attendance };
}

// Village : la présence au rendez-vous d'un proche non connecté entre dans
// l'historique des relais (UC-33), quelle que soit la route qui la saisit.
async function logAttendance(appointment, attendance, userId) {
  if (!attendance) return;
  const [task] = await db
    .select({ id: relayTasks.id })
    .from(relayTasks)
    .where(and(eq(relayTasks.appointmentId, appointment.id), eq(relayTasks.appointmentDate, appointment.appointmentDate)));
  if (task) await logRelayEvent(task.id, attendance, userId);
}

// L'heure saisie dans le formulaire (« AAAA-MM-JJTHH:MM », sans fuseau) est
// celle de l'application (APP_TIMEZONE) : voir lib/validation.js parseDateTime.
router.post(
  "/",
  requireFamilyMembership((req) => familyIdFromMemberId(req.body.memberId)),
  async (req, res) => {
    try {
      const { title, notes } = req.body;
      const memberId = parseId(req.body.memberId);
      if (!memberId || typeof title !== "string" || !title.trim() || !req.body.appointmentDate) {
        return res.status(400).json({ error: "Données manquantes" });
      }
      const appointmentDate = parseDateTime(req.body.appointmentDate);
      if (!appointmentDate) return res.status(400).json({ error: INVALID_DATETIME });
      const values = {
        title: title.trim(),
        doctorName: optionalText(req.body.doctorName),
        location: optionalText(req.body.location),
      };
      const long = tooLongAppointment(values);
      if (long) return res.status(400).json({ error: long });
      const status = req.body.status ?? "pending";
      if (!STATUSES.includes(status)) return res.status(400).json({ error: "Statut invalide" });
      const attendance = resolveAttendance(req.body.attendance, appointmentDate, status);
      if (attendance.error) return res.status(400).json({ error: attendance.error });
      if (!(await canWriteMember(req, memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }
      const [created] = await db
        .insert(appointments)
        .values({
          memberId,
          ...values,
          appointmentDate,
          notes: typeof notes === "string" && notes ? notes : null,
          status,
          attendance: attendance.value,
        })
        .returning();
      res.status(201).json(created);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Modification. Seuls les champs présents dans la requête changent : un
// champ absent garde sa valeur (il n'est jamais remis à vide). Un rendez-vous
// annulé ou déplacé clôt la tâche Village de l'ancienne date et prévient
// gestionnaires et relais (reminders/village.js onAppointmentChanged).
router.put(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(appointments, req.body.id)),
  async (req, res) => {
    try {
      const body = req.body;
      const id = parseId(body.id);
      const [existing] = await db.select().from(appointments).where(eq(appointments.id, id));
      if (!existing) return res.status(404).json({ error: "Rendez-vous introuvable" });
      if (!(await canWriteMember(req, existing.memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      const changes = {};
      if ("title" in body) {
        if (typeof body.title !== "string" || !body.title.trim()) return res.status(400).json({ error: "Le titre est requis" });
        changes.title = body.title.trim();
      }
      if ("doctorName" in body) changes.doctorName = optionalText(body.doctorName);
      if ("location" in body) changes.location = optionalText(body.location);
      if ("notes" in body) changes.notes = typeof body.notes === "string" && body.notes ? body.notes : null;
      if ("appointmentDate" in body) {
        const parsed = parseDateTime(body.appointmentDate);
        if (!parsed) return res.status(400).json({ error: INVALID_DATETIME });
        changes.appointmentDate = parsed;
      }
      const long = tooLongAppointment(changes);
      if (long) return res.status(400).json({ error: long });

      const status = body.status ?? existing.status;
      if (!STATUSES.includes(status)) return res.status(400).json({ error: "Statut invalide" });
      const date = changes.appointmentDate ?? existing.appointmentDate;
      // Présence absente de la requête : on garde l'existante si elle reste
      // valable (rendez-vous toujours passé et non annulé), sinon on l'efface.
      const requested = "attendance" in body ? body.attendance : existing.attendance;
      const attendance = resolveAttendance(requested, date, status);
      if (attendance.error && "attendance" in body) return res.status(400).json({ error: attendance.error });

      const [updated] = await db
        .update(appointments)
        .set({ ...changes, status, attendance: attendance.error ? null : attendance.value })
        .where(eq(appointments.id, id))
        .returning();

      const moved = updated.appointmentDate.getTime() !== existing.appointmentDate.getTime();
      const cancelled = updated.status === "cancelled" && existing.status !== "cancelled";
      if (moved || cancelled) await onAppointmentChanged(existing, updated, req.user.id);
      if (updated.attendance && updated.attendance !== existing.attendance) {
        await logAttendance(updated, updated.attendance, req.user.id);
      }
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Renseigner la présence seule (« s'y est rendu » / « n'y est pas allé » ou
// null pour effacer) — boutons rapides de la liste, sans renvoyer tout le
// rendez-vous.
router.put(
  "/attendance",
  requireFamilyMembership((req) => familyIdFromResource(appointments, req.body.id)),
  async (req, res) => {
    try {
      const [existing] = await db.select().from(appointments).where(eq(appointments.id, parseId(req.body.id)));
      if (!existing) return res.status(404).json({ error: "Rendez-vous introuvable" });
      if (!(await canWriteMember(req, existing.memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }
      const attendance = resolveAttendance(req.body.attendance, existing.appointmentDate, existing.status);
      if (attendance.error) return res.status(400).json({ error: attendance.error });
      const [updated] = await db
        .update(appointments)
        .set({ attendance: attendance.value })
        .where(eq(appointments.id, existing.id))
        .returning();
      await logAttendance(existing, attendance.value, req.user.id);
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Suppression — Titulaire, Gestionnaire de ce dossier, ou Parent (Admin).
// Comme une annulation pour le Village : gestionnaires et relais prévenus.
router.delete(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(appointments, req.query.id)),
  async (req, res) => {
    try {
      const id = parseId(req.query.id);
      if (!id) return res.status(400).json({ error: INVALID_ID });

      const [existing] = await db.select().from(appointments).where(eq(appointments.id, id));
      if (!existing) return res.status(404).json({ error: "Rendez-vous introuvable" });
      if (!(await canWriteMember(req, existing.memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      if (existing.status !== "cancelled") await onAppointmentChanged(existing, null, req.user.id);
      await db.delete(appointments).where(eq(appointments.id, id));
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;
