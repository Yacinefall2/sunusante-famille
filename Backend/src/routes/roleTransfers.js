import { Router } from "express";
import { and, desc, eq, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import { documentRoles, members, roleTransfers, users } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { ACCESS, computeFamilyAccess, membershipOf, setDocumentRole } from "../lib/documentAccess.js";
import { isManagedFiche } from "../lib/management.js";
import { purgeNotificationsWithoutAccess } from "../lib/archive.js";
import { familyIdFromQuery } from "../lib/familyResolvers.js";
import { INVALID_ID, parseId } from "../lib/validation.js";
import { fullName, logActivity } from "../lib/activityLog.js";
import { formatDateTime } from "../lib/time.js";
import { notify } from "../reminders/notify.js";
import { readTransferNotifications } from "../reminders/roles.js";

// ── Transférer la gestion d'un dossier à un autre membre (UC-39) ─────────────
// Le gestionnaire d'une fiche gérée (ou un parent qui en a l'accès complet)
// PROPOSE à un autre compte adulte de la famille d'en reprendre la gestion ;
// le destinataire accepte ou refuse, le proposant peut annuler. Sans réponse
// au bout de 7 jours, la proposition expire (worker, reminders/roles.js).
// À l'acceptation, le destinataire devient gestionnaire et le proposant perd
// son rôle de gestionnaire sur cette fiche (un parent qui proposait sans être
// gestionnaire garde son accès de parent).
const router = Router();

export const TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const fromUsers = alias(users, "from_users");
const toUsers = alias(users, "to_users");
const userCols = (u) => ({ id: u.id, name: u.name, email: u.email, emailVerified: u.emailVerified });

// Le compte peut-il proposer le transfert de la gestion de cette fiche ?
// Gestionnaire désigné avec l'accès complet, ou parent avec l'accès complet ;
// jamais un adolescent.
async function canPropose(membership, familyId, memberId) {
  if (!membership || membership.role === "dependent") return false;
  const access = await computeFamilyAccess({
    userId: membership.userId,
    familyId,
    role: membership.role,
    linkedMemberId: membership.linkedMemberId,
  });
  if (access.get(memberId) !== ACCESS.FULL) return false;
  if (membership.role === "parent") return true;
  const [role] = await db
    .select({ id: documentRoles.id })
    .from(documentRoles)
    .where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.userId, membership.userId), eq(documentRoles.role, "gestionnaire")));
  return !!role;
}

async function isManager(memberId, userId, executor = db) {
  const [row] = await executor
    .select({ id: documentRoles.id })
    .from(documentRoles)
    .where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.userId, userId), eq(documentRoles.role, "gestionnaire")));
  return !!row;
}

// Destinataire valable : compte adulte ou parent de la famille (jamais un
// adolescent), autre que le proposant, pas déjà gestionnaire de la fiche, et
// pas son titulaire. Renvoie un message d'erreur, ou null.
async function recipientError(toUserId, fromUserId, familyId, memberId) {
  if (toUserId === fromUserId) return "Vous ne pouvez pas vous proposer la gestion à vous-même";
  const target = await membershipOf(toUserId, familyId);
  if (!target) return "Ce compte n'appartient pas à cet espace familial";
  if (target.role === "dependent") return "Un compte adolescent ne peut pas reprendre la gestion d'un dossier";
  if (target.linkedMemberId === memberId) return "Cette personne est titulaire de ce dossier";
  if (await isManager(memberId, toUserId)) return "Cette personne est déjà gestionnaire de ce dossier";
  return null;
}

// Mise en forme d'une proposition pour l'interface.
function present(rows) {
  return rows.map(({ t, m, from, to }) => ({
    id: t.id,
    memberId: t.memberId,
    memberName: fullName(m),
    fromUserId: t.fromUserId,
    fromName: from.name,
    toUserId: t.toUserId,
    toName: to.name,
    status: t.status,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    respondedAt: t.respondedAt,
  }));
}

function selectTransfers() {
  return db
    .select({ t: roleTransfers, m: members, from: userCols(fromUsers), to: userCols(toUsers) })
    .from(roleTransfers)
    .innerJoin(members, eq(members.id, roleTransfers.memberId))
    .innerJoin(fromUsers, eq(fromUsers.id, roleTransfers.fromUserId))
    .innerJoin(toUsers, eq(toUsers.id, roleTransfers.toUserId));
}

// Propositions en attente de l'utilisateur dans une famille : reçues (à
// accepter ou refuser) et envoyées (annulables). Avec ?memberId=, aussi la
// proposition en attente sur cette fiche si l'utilisateur peut en proposer
// le transfert (affichage sur la fiche).
router.get("/", requireFamilyMembership(familyIdFromQuery), async (req, res) => {
  try {
    const rows = await selectTransfers()
      .where(
        and(
          eq(roleTransfers.familyId, req.familyId),
          eq(roleTransfers.status, "pending"),
          or(eq(roleTransfers.toUserId, req.user.id), eq(roleTransfers.fromUserId, req.user.id))
        )
      )
      .orderBy(desc(roleTransfers.createdAt));
    const list = await present(rows);
    const result = {
      received: list.filter((t) => t.toUserId === req.user.id),
      sent: list.filter((t) => t.fromUserId === req.user.id),
    };
    if (req.query.memberId) {
      const memberId = parseId(req.query.memberId);
      if (!memberId) return res.status(400).json({ error: INVALID_ID });
      const [fiche] = await db.select().from(members).where(and(eq(members.id, memberId), eq(members.familyId, req.familyId)));
      const allowed = !!fiche && (await canPropose(req.membership, req.familyId, memberId));
      const [pending] = allowed
        ? await present(
            await selectTransfers().where(and(eq(roleTransfers.memberId, memberId), eq(roleTransfers.status, "pending")))
          )
        : [];
      result.member = {
        canTransfer: allowed && (await isManagedFiche(fiche)),
        pending: pending ?? null,
      };
    }
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

async function familyOfMemberBody(req) {
  const memberId = parseId(req.body?.memberId);
  if (!memberId) return null;
  const [m] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, memberId));
  return m?.familyId ?? null;
}

// Proposer le transfert : { memberId, toUserId }.
router.post("/", requireFamilyMembership(familyOfMemberBody), async (req, res) => {
  try {
    const memberId = parseId(req.body.memberId);
    const toUserId = parseId(req.body.toUserId);
    if (!toUserId) return res.status(400).json({ error: "Choisissez la personne à qui proposer la gestion" });
    const [fiche] = await db.select().from(members).where(eq(members.id, memberId));
    if (!(await canPropose(req.membership, req.familyId, memberId))) {
      return res.status(403).json({ error: "Seul un gestionnaire de ce dossier, ou un parent, peut en proposer le transfert" });
    }
    if (!(await isManagedFiche(fiche))) {
      return res.status(400).json({ error: "Ce dossier est tenu par son titulaire : sa gestion ne se transfère pas" });
    }
    const invalid = await recipientError(toUserId, req.user.id, req.familyId, memberId);
    if (invalid) return res.status(400).json({ error: invalid });

    const now = new Date();
    const [created] = await db
      .insert(roleTransfers)
      .values({ familyId: req.familyId, memberId, fromUserId: req.user.id, toUserId, createdAt: now, expiresAt: new Date(now.getTime() + TRANSFER_TTL_MS) })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      return res.status(409).json({ error: "Une proposition de transfert de ce dossier est déjà en attente de réponse" });
    }
    const [to] = await db.select(userCols(users)).from(users).where(eq(users.id, toUserId));
    await notify({
      user: to,
      category: "role_transfer",
      dedupeKey: `role_transfer:${created.id}:proposed:u${to.id}`,
      title: `${req.user.name} vous propose de reprendre la gestion du dossier de ${fullName(fiche)}`,
      body: `Acceptez ou refusez depuis votre tableau de bord avant le ${formatDateTime(created.expiresAt)}.`,
      link: "/dashboard",
      familyId: req.familyId,
      memberId: null,
      now,
    });
    await logActivity({ familyId: req.familyId, actor: req.user, action: "role_transfer_proposed", member: fiche, target: to, at: now });
    const [presented] = await present(await selectTransfers().where(eq(roleTransfers.id, created.id)));
    res.status(201).json(presented);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Charge la proposition (:id) et la famille correspondante.
function withTransfer(handler) {
  return [
    async (req, res, next) => {
      try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: INVALID_ID });
        const [transfer] = await db.select().from(roleTransfers).where(eq(roleTransfers.id, id));
        if (!transfer) return res.status(404).json({ error: "Proposition introuvable" });
        req.transfer = transfer;
        next();
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur serveur" });
      }
    },
    requireFamilyMembership((req) => req.transfer.familyId),
    async (req, res) => {
      try {
        if (req.transfer.status !== "pending") {
          return res.status(409).json({ error: "Cette proposition n'est plus en attente" });
        }
        if (req.transfer.expiresAt <= new Date()) {
          return res.status(410).json({ error: "Cette proposition a expiré" });
        }
        await handler(req, res);
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur serveur" });
      }
    },
  ];
}

// Clôt la proposition (statut final) si elle est toujours en attente.
async function close(transferId, status, now, executor = db) {
  const [row] = await executor
    .update(roleTransfers)
    .set({ status, respondedAt: now })
    .where(and(eq(roleTransfers.id, transferId), eq(roleTransfers.status, "pending")))
    .returning();
  return row ?? null;
}

async function notifyProposer(transfer, { title, body, kind, now }) {
  const [from] = await db.select(userCols(users)).from(users).where(eq(users.id, transfer.fromUserId));
  if (!from) return;
  await notify({
    user: from,
    category: "role_transfer",
    dedupeKey: `role_transfer:${transfer.id}:${kind}:u${from.id}`,
    title,
    body,
    link: `/fiches?fiche=${transfer.memberId}`,
    familyId: transfer.familyId,
    memberId: null,
    now,
  });
}

// Accepter : le destinataire devient gestionnaire ; le proposant perd son
// rôle de gestionnaire sur cette fiche (s'il en avait un).
router.post(
  "/:id/accept",
  ...withTransfer(async (req, res) => {
    const t = req.transfer;
    if (t.toUserId !== req.user.id) return res.status(403).json({ error: "Cette proposition ne vous est pas destinée" });
    if (req.membership.role === "dependent") {
      return res.status(403).json({ error: "Un compte adolescent ne peut pas reprendre la gestion d'un dossier" });
    }
    const [fiche] = await db.select().from(members).where(eq(members.id, t.memberId));
    if (!(await isManagedFiche(fiche))) {
      return res.status(409).json({ error: "Ce dossier n'est plus géré : il est tenu par son titulaire ou archivé" });
    }
    const proposer = await membershipOf(t.fromUserId, t.familyId);
    if (!(await canPropose(proposer, t.familyId, t.memberId))) {
      return res.status(409).json({ error: "La personne qui vous a fait cette proposition ne gère plus ce dossier" });
    }
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const closed = await close(t.id, "accepted", now, tx);
      if (!closed) return null;
      const proposerWasManager = await isManager(t.memberId, t.fromUserId, tx);
      await setDocumentRole(t.memberId, req.user.id, "gestionnaire", { executor: tx });
      if (proposerWasManager) {
        await tx
          .delete(documentRoles)
          .where(and(eq(documentRoles.memberId, t.memberId), eq(documentRoles.userId, t.fromUserId), eq(documentRoles.role, "gestionnaire")));
      }
      return { closed, proposerWasManager };
    });
    if (!result) return res.status(409).json({ error: "Cette proposition n'est plus en attente" });
    await purgeNotificationsWithoutAccess(t.memberId, t.fromUserId);
    await readTransferNotifications(t.id, now);
    await notifyProposer(t, {
      kind: "accepted",
      title: `${req.user.name} a accepté de reprendre la gestion du dossier de ${fullName(fiche)}`,
      body: result.proposerWasManager ? "Vous n'en êtes plus gestionnaire." : "Il ou elle en est désormais gestionnaire.",
      now,
    });
    await logActivity({
      familyId: t.familyId,
      actor: req.user,
      action: "role_transfer_accepted",
      member: fiche,
      target: t.fromUserId,
      details: { proposerWasManager: result.proposerWasManager },
      at: now,
    });
    res.json({ ...result.closed, proposerWasManager: result.proposerWasManager });
  })
);

// Refuser : rien ne change ; le proposant en est prévenu.
router.post(
  "/:id/decline",
  ...withTransfer(async (req, res) => {
    const t = req.transfer;
    if (t.toUserId !== req.user.id) return res.status(403).json({ error: "Cette proposition ne vous est pas destinée" });
    const now = new Date();
    const closed = await close(t.id, "declined", now);
    if (!closed) return res.status(409).json({ error: "Cette proposition n'est plus en attente" });
    const [fiche] = await db.select().from(members).where(eq(members.id, t.memberId));
    await readTransferNotifications(t.id, now);
    await notifyProposer(t, {
      kind: "declined",
      title: `${req.user.name} a refusé de reprendre la gestion du dossier de ${fullName(fiche)}`,
      body: "Vous en restez gestionnaire. Vous pouvez proposer la gestion à quelqu'un d'autre.",
      now,
    });
    await logActivity({ familyId: t.familyId, actor: req.user, action: "role_transfer_declined", member: fiche, target: t.fromUserId, at: now });
    res.json(closed);
  })
);

// Annuler : réservé au proposant.
router.post(
  "/:id/cancel",
  ...withTransfer(async (req, res) => {
    const t = req.transfer;
    if (t.fromUserId !== req.user.id) return res.status(403).json({ error: "Seule la personne qui a fait la proposition peut l'annuler" });
    const now = new Date();
    const closed = await close(t.id, "cancelled", now);
    if (!closed) return res.status(409).json({ error: "Cette proposition n'est plus en attente" });
    await readTransferNotifications(t.id, now);
    await logActivity({ familyId: t.familyId, actor: req.user, action: "role_transfer_cancelled", member: t.memberId, target: t.toUserId, at: now });
    res.json(closed);
  })
);

export default router;
