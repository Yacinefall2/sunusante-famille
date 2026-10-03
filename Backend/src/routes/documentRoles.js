import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentRoles, familyMemberships, members, users } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { DOCUMENT_ROLES, canManageRoles, setDocumentRole } from "../lib/documentAccess.js";

const router = Router();

async function resolveFamilyIdFromMemberQuery(req) {
  const id = parseInt(req.query.memberId ?? "");
  if (!id) return null;
  const [member] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, id));
  return member?.familyId ?? null;
}

async function resolveFamilyIdFromMemberBody(req) {
  const id = parseInt(req.body?.memberId ?? "");
  if (!id) return null;
  const [member] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, id));
  return member?.familyId ?? null;
}

// Pour DELETE, req.query.id est l'id de la ligne document_roles elle-même
// (pas un memberId) — on doit remonter jusqu'au memberId pour retrouver la famille.
async function resolveFamilyIdFromDocumentRoleId(req) {
  const id = parseInt(req.query.id ?? "");
  if (!id) return null;
  const [row] = await db.select({ memberId: documentRoles.memberId }).from(documentRoles).where(eq(documentRoles.id, id));
  if (!row) return null;
  const [member] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, row.memberId));
  return member?.familyId ?? null;
}

// Liste des rôles Axe 2 attribués sur une fiche — écran de gestion des
// accès d'un dossier (UC-04). Visible de qui peut gérer ces rôles : le
// Titulaire de la fiche ou un Administrateur y ayant un accès complet.
router.get(
  "/",
  requireFamilyMembership(resolveFamilyIdFromMemberQuery),
  async (req, res) => {
    try {
      const memberId = parseInt(req.query.memberId);
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
// de son propre dossier par le Titulaire (UC-26).
router.post(
  "/",
  requireFamilyMembership(resolveFamilyIdFromMemberBody),
  async (req, res) => {
    try {
      const { memberId, userId, role } = req.body;
      if (!memberId || !userId || !DOCUMENT_ROLES.includes(role)) {
        return res.status(400).json({ error: "Données manquantes ou rôle invalide" });
      }
      if (!(await canManageRoles(req, memberId))) {
        return res.status(403).json({ error: "Vous ne pouvez pas gérer les accès de ce dossier" });
      }
      // Un rôle de dossier n'est attribué qu'à un compte de CET espace
      // familial (le Relais est réservé à un membre de la famille, §11).
      const [targetMembership] = await db
        .select({ id: familyMemberships.id })
        .from(familyMemberships)
        .where(and(eq(familyMemberships.userId, parseInt(userId)), eq(familyMemberships.familyId, req.familyId)));
      if (!targetMembership) {
        return res.status(400).json({ error: "Ce compte n'appartient pas à cet espace familial" });
      }
      // Le Titulaire d'une fiche en a déjà l'accès complet : pas de rôle en plus.
      const [holder] = await db
        .select({ id: familyMemberships.id })
        .from(familyMemberships)
        .where(and(eq(familyMemberships.userId, parseInt(userId)), eq(familyMemberships.linkedMemberId, parseInt(memberId))));
      if (holder) {
        return res.status(400).json({ error: "Cette personne est déjà titulaire de ce dossier" });
      }
      const created = await setDocumentRole(parseInt(memberId), parseInt(userId), role);
      res.status(201).json(created);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Révoquer un rôle Axe 2 — révocable à tout moment, par le Titulaire de la
// fiche ou par un Administrateur y ayant un accès complet (§10 « Révocation »).
router.delete(
  "/",
  requireFamilyMembership(resolveFamilyIdFromDocumentRoleId),
  async (req, res) => {
    try {
      const id = parseInt(req.query.id ?? "");
      if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });
      const [row] = await db.select({ memberId: documentRoles.memberId }).from(documentRoles).where(eq(documentRoles.id, id));
      if (!(await canManageRoles(req, row.memberId))) {
        return res.status(403).json({ error: "Vous ne pouvez pas gérer les accès de ce dossier" });
      }
      await db.delete(documentRoles).where(eq(documentRoles.id, id));
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;