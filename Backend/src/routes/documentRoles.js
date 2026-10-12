import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentRoles, members, users } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import {
  DOCUMENT_ROLES,
  DURATION_REQUIRED_ERROR,
  canManageRoles,
  expiryFor,
  isRoleDuration,
  membershipOf,
  setDocumentRole,
} from "../lib/documentAccess.js";
import { purgeNotificationsWithoutAccess } from "../lib/archive.js";
import { INVALID_ID, parseId } from "../lib/validation.js";
import { logActivity } from "../lib/activityLog.js";

const router = Router();

async function familyOfMember(memberId) {
  if (!memberId) return null;
  const [member] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, memberId));
  return member?.familyId ?? null;
}

const resolveFamilyIdFromMemberQuery = (req) => familyOfMember(parseId(req.query.memberId));
const resolveFamilyIdFromMemberBody = (req) => familyOfMember(parseId(req.body?.memberId));

// Pour DELETE, req.query.id est l'id de la ligne document_roles elle-même
// (pas un memberId) — on doit remonter jusqu'au memberId pour retrouver la
// famille. Même chose pour la prolongation (/:id/extend).
async function familyOfDocumentRole(rawId) {
  const id = parseId(rawId);
  if (!id) return null;
  const [row] = await db.select({ memberId: documentRoles.memberId }).from(documentRoles).where(eq(documentRoles.id, id));
  if (!row) return null;
  return familyOfMember(row.memberId);
}
const resolveFamilyIdFromDocumentRoleId = (req) => familyOfDocumentRole(req.query.id);
const resolveFamilyIdFromDocumentRoleParam = (req) => familyOfDocumentRole(req.params.id);

// Liste des rôles Axe 2 attribués sur une fiche — écran de gestion des
// accès d'un dossier (UC-04). Visible de qui peut gérer ces rôles : le
// Titulaire de la fiche ou un Administrateur y ayant un accès complet.
// expiresAt : fin de l'accès d'un Lecteur invité (NULL pour les autres rôles).
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
          expiresAt: documentRoles.expiresAt,
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
// Lecteur invité (R4) : durée obligatoire — `duration` parmi "7j", "30j",
// "3m", "1a" — l'accès prend fin à l'échéance.
router.post(
  "/",
  requireFamilyMembership(resolveFamilyIdFromMemberBody),
  async (req, res) => {
    try {
      const { role, duration } = req.body;
      const memberId = parseId(req.body.memberId);
      const userId = parseId(req.body.userId);
      if (!memberId || !userId || !DOCUMENT_ROLES.includes(role)) {
        return res.status(400).json({ error: "Données manquantes ou rôle invalide" });
      }
      if (role === "lecteur_invite" && !isRoleDuration(duration)) {
        return res.status(400).json({ error: DURATION_REQUIRED_ERROR });
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
      const [previous] = await db
        .select({ role: documentRoles.role })
        .from(documentRoles)
        .where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.userId, userId)));
      const expiresAt = role === "lecteur_invite" ? expiryFor(duration) : null;
      const created = await setDocumentRole(memberId, userId, role, { expiresAt });
      const durationDetails = expiresAt ? { duration, expiresAt: expiresAt.toISOString() } : {};
      if (previous?.role !== role) {
        await logActivity({
          familyId: req.familyId,
          actor: req.user,
          action: previous ? "document_role_changed" : "document_role_granted",
          member: memberId,
          target: userId,
          details: previous ? { from: previous.role, to: role, ...durationDetails } : { role, ...durationDetails },
        });
      } else if (expiresAt) {
        // Même rôle de lecteur invité redonné : c'est une nouvelle durée.
        await logActivity({
          familyId: req.familyId,
          actor: req.user,
          action: "document_role_extended",
          member: memberId,
          target: userId,
          details: durationDetails,
        });
      }
      res.status(201).json(created);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Prolonger en un clic l'accès d'un Lecteur invité (R4) — par qui peut gérer
// les rôles de la fiche. La durée s'ajoute à l'échéance en cours (ou à
// maintenant si elle est déjà passée).
router.post(
  "/:id/extend",
  requireFamilyMembership(resolveFamilyIdFromDocumentRoleParam),
  async (req, res) => {
    try {
      const id = parseId(req.params.id);
      const { duration } = req.body ?? {};
      if (!isRoleDuration(duration)) return res.status(400).json({ error: DURATION_REQUIRED_ERROR });
      const [row] = await db.select().from(documentRoles).where(eq(documentRoles.id, id));
      if (!(await canManageRoles(req, row.memberId))) {
        return res.status(403).json({ error: "Vous ne pouvez pas gérer les accès de ce dossier" });
      }
      if (row.role !== "lecteur_invite") {
        return res.status(400).json({ error: "Seul l'accès d'un lecteur invité est limité dans le temps" });
      }
      const now = new Date();
      const from = row.expiresAt && row.expiresAt > now ? row.expiresAt : now;
      const expiresAt = expiryFor(duration, from);
      const [updated] = await db.update(documentRoles).set({ expiresAt }).where(eq(documentRoles.id, id)).returning();
      await logActivity({
        familyId: req.familyId,
        actor: req.user,
        action: "document_role_extended",
        member: row.memberId,
        target: row.userId,
        details: { duration, expiresAt: expiresAt.toISOString() },
      });
      res.json(updated);
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
      await logActivity({
        familyId: req.familyId,
        actor: req.user,
        action: "document_role_revoked",
        member: row.memberId,
        target: row.userId,
        details: { role: row.role },
      });
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;
