import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentRoles, familyMemberships, members, users } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { DOCUMENT_ROLES, setDocumentRole } from "../lib/documentAccess.js";

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

// Liste des rôles Axe 2 attribués sur une fiche — utile pour l'écran de
// gestion des accès d'un dossier (UC-04). Réservé aux Parents (A1/A2), qui
// sont les seuls habilités à consulter/modifier l'attribution des rôles.
router.get(
  "/",
  requireFamilyMembership(resolveFamilyIdFromMemberQuery, { roles: ["parent"] }),
  async (req, res) => {
    try {
      const memberId = parseInt(req.query.memberId);
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

// Attribuer un rôle Axe 2 (Titulaire / Gestionnaire / Relais / Lecteur
// invité) à un membre de l'espace familial sur une fiche donnée — UC-04.
router.post(
  "/",
  requireFamilyMembership(resolveFamilyIdFromMemberBody, { roles: ["parent"] }),
  async (req, res) => {
    try {
      const { memberId, userId, role } = req.body;
      if (!memberId || !userId || !DOCUMENT_ROLES.includes(role)) {
        return res.status(400).json({ error: "Données manquantes ou rôle invalide" });
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
      const created = await setDocumentRole(parseInt(memberId), parseInt(userId), role);
      res.status(201).json(created);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Révoquer un rôle Axe 2 — un rôle de dossier est révocable à tout moment
// (règle transverse §10). Réservé aux Parents pour cette version ; la
// révocation par le Titulaire lui-même viendra avec l'écran dédié.
router.delete(
  "/",
  requireFamilyMembership(resolveFamilyIdFromDocumentRoleId, { roles: ["parent"] }),
  async (req, res) => {
    try {
      const id = parseInt(req.query.id ?? "");
      if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });
      await db.delete(documentRoles).where(eq(documentRoles.id, id));
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;