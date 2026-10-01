import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { members, appointments, treatments, vaccinations, documents } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";

const router = Router();

router.get(
  "/",
  requireFamilyMembership((req) => parseInt(req.query.familyId) || null),
  async (req, res) => {
    try {
      const familyId = req.familyId;

      // Un Dépendant n'a un dashboard scopé qu'à sa propre fiche liée —
      // le reste de la logique (agrégation) fonctionne à l'identique, juste
      // sur une liste d'un seul membre au lieu de toute la famille.
      let familyMembers;
      if (req.membership.role === "dependent") {
        if (!req.membership.linkedMemberId) {
          return res.json({
            membersCount: 0,
            upcomingAppointments: [],
            activeTreatmentsCount: 0,
            recentVaccinations: [],
            recentDocuments: [],
          });
        }
        familyMembers = await db.select().from(members).where(eq(members.id, req.membership.linkedMemberId));
      } else {
        familyMembers = await db.select().from(members).where(eq(members.familyId, familyId));
      }

      if (familyMembers.length === 0) {
        return res.json({
          membersCount: 0,
          upcomingAppointments: [],
          activetreatments: 0,
          recentVaccinations: [],
          recentDocuments: [],
        });
      }

      const memberIds = familyMembers.map((m) => m.id);
      const now = new Date();

      const upcomingAppointments = await db
        .select()
        .from(appointments)
        .where(inArray(appointments.memberId, memberIds))
        .orderBy(appointments.appointmentDate);

      const upcoming = upcomingAppointments
        .filter((a) => new Date(a.appointmentDate) >= now && a.status === "upcoming")
        .slice(0, 5);

      const activeTreatments = await db
        .select()
        .from(treatments)
        .where(inArray(treatments.memberId, memberIds));

      const activeCount = activeTreatments.filter((t) => t.isActive).length;

      const allVaccinations = await db
        .select()
        .from(vaccinations)
        .where(inArray(vaccinations.memberId, memberIds))
        .orderBy(vaccinations.dateAdministered);

      const recentVaccinations = allVaccinations.slice(-5).reverse();

      const allDocuments = await db
        .select()
        .from(documents)
        .where(inArray(documents.memberId, memberIds))
        .orderBy(documents.uploadedAt);

      const recentDocuments = allDocuments.slice(-5).reverse();

      const membersMap = Object.fromEntries(familyMembers.map((m) => [m.id, m]));

      res.json({
        membersCount: familyMembers.length,
        members: familyMembers,
        upcomingAppointments: upcoming.map((a) => ({
          ...a,
          member: membersMap[a.memberId],
        })),
        activeTreatmentsCount: activeCount,
        recentVaccinations: recentVaccinations.map((v) => ({
          ...v,
          member: membersMap[v.memberId],
        })),
        recentDocuments: recentDocuments.map((d) => ({
          ...d,
          member: membersMap[d.memberId],
        })),
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;