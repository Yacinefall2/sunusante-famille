import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { appointments } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdForListQuery, familyIdFromMemberId, familyIdFromResource } from "../lib/familyResolvers.js";
import { ACCESS, canRead, canWriteMember, getFamilyAccess } from "../lib/documentAccess.js";

const router = Router();

router.get("/", requireFamilyMembership(familyIdForListQuery), async (req, res) => {
  try {
    // Fiches lisibles (dossier complet) + fiches dont on est Relais : pour
    // celles-ci, seuls la date, l'heure et le lieu sont renvoyés (§4.4) —
    // ni le titre, ni le praticien, ni les notes.
    const access = await getFamilyAccess(req);
    const visible = (id) => canRead(access.get(id)) || access.get(id) === ACCESS.RELAY;
    let memberIds;
    if (req.query.memberId) {
      const id = parseInt(req.query.memberId);
      if (!visible(id)) return res.status(403).json({ error: "Accès refusé à ce dossier" });
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

router.post(
  "/",
  requireFamilyMembership((req) => familyIdFromMemberId(req.body.memberId)),
  async (req, res) => {
    try {
      const { memberId, title, doctorName, location, appointmentDate, notes, status } = req.body;
      if (!memberId || !title?.trim() || !appointmentDate) {
        return res.status(400).json({ error: "Données manquantes" });
      }
      if (!(await canWriteMember(req, parseInt(memberId)))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }
      const [created] = await db
        .insert(appointments)
        .values({
          memberId: parseInt(memberId),
          title: title.trim(),
          doctorName: doctorName || null,
          location: location || null,
          appointmentDate: new Date(appointmentDate),
          notes: notes || null,
          status: status || "upcoming",
        })
        .returning();
      res.status(201).json(created);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

router.put(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(appointments, req.body.id)),
  async (req, res) => {
    try {
      const { id, title, doctorName, location, appointmentDate, notes, status } = req.body;

      const [existing] = await db.select({ memberId: appointments.memberId }).from(appointments).where(eq(appointments.id, parseInt(id)));
      if (!existing) return res.status(404).json({ error: "Rendez-vous introuvable" });
      if (!(await canWriteMember(req, existing.memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      const [updated] = await db
        .update(appointments)
        .set({
          title: title?.trim(),
          doctorName: doctorName || null,
          location: location || null,
          appointmentDate: appointmentDate ? new Date(appointmentDate) : undefined,
          notes: notes || null,
          status: status || "upcoming",
        })
        .where(eq(appointments.id, parseInt(id)))
        .returning();
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Suppression — Titulaire, Gestionnaire de ce dossier, ou Parent (Admin).
router.delete(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(appointments, req.query.id)),
  async (req, res) => {
    try {
      const id = parseInt(req.query.id ?? "");
      if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });

      const [existing] = await db.select({ memberId: appointments.memberId }).from(appointments).where(eq(appointments.id, id));
      if (!existing) return res.status(404).json({ error: "Rendez-vous introuvable" });
      if (!(await canWriteMember(req, existing.memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      await db.delete(appointments).where(eq(appointments.id, id));
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;