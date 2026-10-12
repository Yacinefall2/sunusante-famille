import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentRoles, members, users } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { DOCUMENT_ROLES, canManageRoles, membershipOf, setDocumentRole } from "../lib/documentAccess.js";
import { purgeNotificationsWithoutAccess } from "../lib/archive.js";
import { INVALID_ID, parseId } from "../lib/validation.js";

const router = Router();

async function familyOfMember(memberId) {
  if (!memberId) return null;
  const [member] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, memberId));
  return member?.familyId ?? null;
}

const resolveFamilyIdFromMemberQuery = (req) => familyOfMember(parseId(req.query.memberId));
const resolveFamilyIdFromMemberBody = (req) => familyOfMember(parseId(req.body?.memberId));

// Pour DELETE, req.query.id est l'id de la ligne document_roles elle-même
// (pas un memberId) — on doit remonter jusqu'au memberId pour retrouver la famille.
async function resolveFamilyIdFromDocumentRoleId(req) {
  const id = parseId(req.query.id);
  if (!id) return null;
  const [row] = await db.select({ memberId: documentRoles.memberId }).from(documentRoles).where(eq(documentRoles.id, id));
  if (!row) return null;
  return familyOfMember(row.memberId);
}

// Liste des rôles Axe 2 attribués sur une fiche — écran de gestion des
// accès d'un dossier (UC-04). Visible de qui peut gérer ces rôles : le
// Titulaire de la fiche ou un Administrateur y ayant un accès complet.
router.get(
  "/",
  requireFamilyMembership(resolveFamilyIdFromMemberQuery),
  async (req, res) => {
    try {
      const memberId = parseId(req.query.memberId);
      if (!(await canManageRoles(req, memberId))) {
        return res.status(403).json({ error: "Vous ne pouvez pas gérer les accès de ce dossier" });
      }
      const rows = await db
        .select({
          id: documentRoles.id,
          role: documentRoles.role,
          userId: documentRoles.userId,
          userName: users.name,
          userEmail: users.email,
          createdAt: documentRoles.createdAt,
        })
        .from(documentRoles)
        .innerJoin(users, eq(users.id, documentRoles.userId))
        .where(eq(documentRoles.memberId, memberId));
      res.json(rows);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Attribuer un rôle Axe 2 (Gestionnaire / Relais / Lecteur invité) à un
// membre de l'espace familial sur une fiche donnée — UC-04, et délégation
// de son propre dossier par le Titulaire (UC-26). On ne s'attribue jamais
// un rôle à soi-même, et un compte adolescent n'en reçoit aucun (§9.6).
router.post(
  "/",
  requireFamilyMembership(resolveFamilyIdFromMemberBody),
  async (req, res) => {
    try {
      const { role } = req.body;
      const memberId = parseId(req.body.memberId);
      const userId = parseId(req.body.userId);
      if (!memberId || !userId || !DOCUMENT_ROLES.includes(role)) {
        return res.status(400).json({ error: "Données manquantes ou rôle invalide" });
      }
      if (!(await canManageRoles(req, memberId))) {
        return res.status(403).json({ error: "Vous ne pouvez pas gérer les accès de ce dossier" });
      }
      if (userId === req.user.id) {
        return res.status(400).json({ error: "Vous ne pouvez pas vous attribuer vous-même un rôle sur un dossier" });
      }
      // Un rôle de dossier n'est attribué qu'à un compte de CET espace
      // familial (le Relais est réservé à un membre de la famille, §11).
      const target = await membershipOf(userId, req.familyId);
      if (!target) {
        return res.status(400).json({ error: "Ce compte n'appartient pas à cet espace familial" });
      }
      // Le Titulaire d'une fiche en a déjà l'accès complet : pas de rôle en plus.
      if (target.linkedMemberId === memberId) {
        return res.status(400).json({ error: "Cette personne est déjà titulaire de ce dossier" });
      }
      // Rôle effectif (selon l'âge) : un adolescent ne lit que sa propre fiche.
      if (target.role === "dependent") {
        return res.status(400).json({ error: "Un compte adolescent ne peut pas recevoir de rôle sur un dossier" });
      }
      const created = await setDocumentRole(memberId, userId, role);
      res.status(201).json(created);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Révoquer un rôle Axe 2 — révocable à tout moment, par le Titulaire de la
// fiche ou par un Administrateur y ayant un accès complet (§10 « Révocation »).
// Les notifications de cette personne sur ce dossier disparaissent si elle
// n'y a plus aucun accès.
router.delete(
  "/",
  requireFamilyMembership(resolveFamilyIdFromDocumentRoleId),
  async (req, res) => {
    try {
      const id = parseId(req.query.id);
      if (!id) return res.status(400).json({ error: INVALID_ID });
      const [row] = await db.select().from(documentRoles).where(eq(documentRoles.id, id));
      if (!(await canManageRoles(req, row.memberId))) {
        return res.status(403).json({ error: "Vous ne pouvez pas gérer les accès de ce dossier" });
      }
      await db.delete(documentRoles).where(eq(documentRoles.id, id));
      await purgeNotificationsWithoutAccess(row.memberId, row.userId);
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;
