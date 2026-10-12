import { Router } from "express";
import { eq, and, isNull, isNotNull, desc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { families, familyMemberships, pendingInvitations, members, users } from "../db/schema.js";
import { requireAuth, requireFamilyMembership, requireVerifiedEmail } from "../middleware/auth.js";
import { generateToken } from "../lib/token.js";
import { hashToken } from "../lib/session.js";
import { QUOTA_MESSAGE, overDailyQuota } from "../lib/sendQuota.js";
import { sendInvitationEmail } from "../lib/mailer.js";
import {
  ACCESS,
  DOCUMENT_ROLES,
  canManageRoles,
  canWriteMember,
  computeFamilyAccess,
  membershipOf,
  setDocumentRole,
} from "../lib/documentAccess.js";
import { ADULT_AGE, ACCOUNT_MIN_AGE, MINOR_PARENT_ERROR, UNDER_MIN_AGE_ERROR, ageOn, effectiveRole } from "../lib/family.js";
import { ARCHIVED_ERROR, afterFicheLinked, restoreArchivedFiche } from "../lib/archive.js";
import { familyIdFromBody, familyIdFromQuery } from "../lib/familyResolvers.js";
import { INVALID_ID, parseId } from "../lib/validation.js";

const router = Router();

const INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
const ALLOWED_ROLES = ["parent", "adult", "dependent"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PARENTS = 2;
const TEEN_ROLE_ERROR = "Un compte adolescent ne peut pas recevoir de rôle sur un dossier";

async function parentCount(familyId) {
  const [{ count }] = await db
    .select({ count: sql`count(*)::int` })
    .from(familyMemberships)
    .where(and(eq(familyMemberships.familyId, familyId), eq(familyMemberships.role, "parent")));
  return count;
}

// Créer une invitation — réservé aux Parents. Le rôle d'espace ET le rôle de
// dossier (le cas échéant) sont fixés AVANT l'envoi, jamais après (§6.2/6.3).
router.post(
  "/",
  requireAuth,
  requireVerifiedEmail,
  requireFamilyMembership(familyIdFromBody, { roles: ["parent"] }),
  async (req, res) => {
    try {
      const { email, linkedMemberId, documentMemberId, documentRole } = req.body;
      // « Membre » : son niveau (adolescent ou adulte) se déduit de l'âge de sa fiche.
      const role = req.body.role === "member" ? "adult" : req.body.role;
      const normalizedEmail = String(email ?? "").toLowerCase().trim();
      if (!EMAIL_RE.test(normalizedEmail) || normalizedEmail.length > 255 || !ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({ error: "Email et rôle valides requis" });
      }
      if (await overDailyQuota(pendingInvitations, pendingInvitations.invitedByUserId, req.user.id)) {
        return res.status(429).json({ error: QUOTA_MESSAGE });
      }

      const [family] = await db.select().from(families).where(eq(families.id, req.familyId));
      if (!family) return res.status(404).json({ error: "Famille introuvable" });

      if (role === "parent") {
        // Inviter un co-administrateur revient à le promouvoir : exclusif
        // à l'Administrateur familial A1 (UC-05, section 9.2).
        if (!req.membership.isPrimaryAdmin) {
          return res.status(403).json({
            error: "Seul l'administrateur qui a créé l'espace familial peut inviter un co-administrateur",
          });
        }
        if ((await parentCount(req.familyId)) >= MAX_PARENTS) {
          return res.status(400).json({ error: `Maximum ${MAX_PARENTS} parents par famille` });
        }
      }

      // Fiche de la personne invitée (« sa fiche ») — obligatoire pour un
      // "dependent", optionnelle sinon (l'invité la créera à son arrivée).
      // Elle doit être libre, non archivée, et l'invitant doit en avoir
      // l'accès complet.
      let validatedLinkedMemberId = null;
      let linkedFiche = null;
      if (role === "dependent" && !linkedMemberId) {
        return res.status(400).json({ error: "Choisissez la fiche membre correspondante" });
      }
      if (linkedMemberId) {
        const parsedId = parseId(linkedMemberId);
        if (!parsedId) return res.status(400).json({ error: INVALID_ID });
        const [member] = await db.select().from(members).where(eq(members.id, parsedId));
        if (!member || member.familyId !== req.familyId) {
          return res.status(400).json({ error: "Fiche membre introuvable dans cette famille" });
        }
        if (member.archivedAt) return res.status(409).json({ error: ARCHIVED_ERROR });
        const [alreadyLinked] = await db
          .select({ id: familyMemberships.id })
          .from(familyMemberships)
          .where(eq(familyMemberships.linkedMemberId, parsedId));
        if (alreadyLinked) {
          return res.status(409).json({ error: "Cette fiche est déjà celle d'un autre compte" });
        }
        if (!(await canWriteMember(req, parsedId))) {
          return res.status(403).json({ error: "Vous n'avez pas les droits sur cette fiche" });
        }
        const age = ageOn(member.dateOfBirth);
        if (age !== null && age < ACCOUNT_MIN_AGE) return res.status(400).json({ error: UNDER_MIN_AGE_ERROR });
        // Un mineur n'est jamais administrateur du foyer.
        if (role === "parent" && age !== null && age < ADULT_AGE) return res.status(400).json({ error: MINOR_PARENT_ERROR });
        validatedLinkedMemberId = parsedId;
        linkedFiche = member;
      }

      // Rôle Axe 2 (optionnel) — le rôle d'espace ET le rôle de dossier sont
      // fixés avant l'envoi, jamais après (§6.2/6.3). S'il est fourni, la
      // fiche visée doit exister dans cette même famille, et l'invité ne doit
      // pas être un adolescent (lecture seule de sa propre fiche, §9.6).
      let validatedDocumentMemberId = null;
      let validatedDocumentRole = null;
      if (documentMemberId || documentRole) {
        const parsedDocMemberId = parseId(documentMemberId);
        if (!parsedDocMemberId || !DOCUMENT_ROLES.includes(documentRole)) {
          return res.status(400).json({ error: "Choisissez un dossier ET un rôle de dossier valides" });
        }
        if (role !== "parent" && effectiveRole(role, linkedFiche?.dateOfBirth) === "dependent") {
          return res.status(400).json({ error: TEEN_ROLE_ERROR });
        }
        const [docMember] = await db.select().from(members).where(eq(members.id, parsedDocMemberId));
        if (!docMember || docMember.familyId !== req.familyId) {
          return res.status(400).json({ error: "Fiche membre introuvable dans cette famille" });
        }
        if (docMember.archivedAt) return res.status(409).json({ error: ARCHIVED_ERROR });
        if (!(await canManageRoles(req, parsedDocMemberId))) {
          return res.status(403).json({ error: "Vous ne pouvez pas gérer les accès de ce dossier" });
        }
        if (parsedDocMemberId === validatedLinkedMemberId) {
          return res.status(400).json({ error: "La personne sera déjà titulaire de ce dossier" });
        }
        validatedDocumentMemberId = parsedDocMemberId;
        validatedDocumentRole = documentRole;
      }

      const token = generateToken();
      const [invitation] = await db
        .insert(pendingInvitations)
        .values({
          familyId: req.familyId,
          email: normalizedEmail,
          role,
          linkedMemberId: validatedLinkedMemberId,
          documentMemberId: validatedDocumentMemberId,
          documentRole: validatedDocumentRole,
          // Seule l'empreinte est conservée ; le jeton ne part que par courriel.
          token: hashToken(token),
          invitedByUserId: req.user.id,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        })
        .returning();

      let documentMemberName = null;
      if (validatedDocumentMemberId) {
        const [docMember] = await db.select().from(members).where(eq(members.id, validatedDocumentMemberId));
        if (docMember) documentMemberName = `${docMember.firstName} ${docMember.lastName}`;
      }

      try {
        await sendInvitationEmail({
          to: normalizedEmail,
          familyName: family.name,
          role,
          token,
          inviterName: req.user.name,
          documentMemberName,
          documentRole: validatedDocumentRole,
        });
      } catch (mailError) {
        // Le jeton n'existe que dans ce courriel : sans envoi, l'invitation
        // est inutilisable — elle est supprimée (comme le lien médecin).
        console.error(mailError);
        await db.delete(pendingInvitations).where(eq(pendingInvitations.id, invitation.id));
        return res.status(502).json({ error: "Le courriel d'invitation n'a pas pu être envoyé. Vérifiez l'adresse et réessayez." });
      }

      const { token: _token, ...publicInvitation } = invitation;
      res.status(201).json(publicInvitation);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Lister les invitations en attente d'une famille — réservé aux Parents
router.get(
  "/",
  requireAuth,
  requireVerifiedEmail,
  requireFamilyMembership(familyIdFromQuery, { roles: ["parent"] }),
  async (req, res) => {
    try {
      const rows = await db
        .select()
        .from(pendingInvitations)
        .where(and(eq(pendingInvitations.familyId, req.familyId), isNull(pendingInvitations.acceptedAt)));
      res.json(rows.map(({ token: _token, ...rest }) => rest));
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Aperçu public d'une invitation (avant connexion) — pas d'authentification
router.get("/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const [invitation] = await db.select().from(pendingInvitations).where(eq(pendingInvitations.token, hashToken(token)));
    if (!invitation) return res.status(404).json({ error: "Invitation introuvable" });

    const [family] = await db.select().from(families).where(eq(families.id, invitation.familyId));

    let linkedMemberName = null;
    if (invitation.linkedMemberId) {
      const [member] = await db.select().from(members).where(eq(members.id, invitation.linkedMemberId));
      if (member) linkedMemberName = `${member.firstName} ${member.lastName}`;
    }

    let documentMemberName = null;
    if (invitation.documentMemberId) {
      const [docMember] = await db.select().from(members).where(eq(members.id, invitation.documentMemberId));
      if (docMember) documentMemberName = `${docMember.firstName} ${docMember.lastName}`;
    }

    res.json({
      email: invitation.email,
      role: invitation.role,
      familyName: family?.name ?? "",
      linkedMemberName,
      documentMemberName,
      documentRole: invitation.documentRole,
      expired: invitation.expiresAt < new Date(),
      accepted: !!invitation.acceptedAt,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Annuler une invitation en attente — réservé aux Parents
router.delete("/", requireAuth, requireVerifiedEmail, async (req, res) => {
  try {
    const id = parseId(req.query.id);
    if (!id) return res.status(400).json({ error: INVALID_ID });

    const [invitation] = await db.select().from(pendingInvitations).where(eq(pendingInvitations.id, id));
    if (!invitation) return res.status(404).json({ error: "Invitation introuvable" });

    const [membership] = await db
      .select()
      .from(familyMemberships)
      .where(and(eq(familyMemberships.userId, req.user.id), eq(familyMemberships.familyId, invitation.familyId)));
    if (!membership || membership.role !== "parent") {
      return res.status(403).json({ error: "Accès refusé" });
    }

    await db.delete(pendingInvitations).where(eq(pendingInvitations.id, id));
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// L'auteur de l'invitation peut-il encore attribuer un rôle sur ce dossier ?
// Même règle que canManageRoles, recalculée pour lui (et non pour l'invité).
async function inviterCanManageRoles(inviter, familyId, memberId) {
  if (inviter.role === "dependent") return false;
  if (inviter.linkedMemberId === memberId) return true;
  if (inviter.role !== "parent") return false;
  const access = await computeFamilyAccess({
    userId: inviter.userId,
    familyId,
    role: inviter.role,
    linkedMemberId: inviter.linkedMemberId,
  });
  return access.get(memberId) === ACCESS.FULL;
}

const NEW_INVITATION = "demandez une nouvelle invitation";

// Accepter l'invitation — nécessite d'être connecté, ET que l'email du
// compte connecté corresponde exactement à l'email invité (c'est le fait
// d'avoir cliqué le lien reçu par email qui prouve la possession de la boîte).
// Note : contrairement aux autres actions, ceci ne passe PAS par
// requireVerifiedEmail — suivre ce lien unique, envoyé à une adresse précise,
// EST la preuve de possession de cette adresse (§6.2). L'acceptation
// vérifie donc elle-même l'adresse au passage, y compris pour un compte tout
// juste créé via ce même écran.
//
// Tout ce qui a été vérifié à l'envoi est revérifié ici, l'espace ayant pu
// changer depuis : l'auteur est-il encore parent (A1 pour inviter un
// parent) ? reste-t-il une place de parent ? la fiche prévue existe-t-elle
// encore et est-elle libre ? le rôle de dossier prévu est-il encore
// attribuable ? Si l'invité avait déjà une fiche dans cette famille
// (archivée à son départ), elle lui est rendue.
router.post("/:token/accept", requireAuth, async (req, res) => {
  try {
    const { token } = req.params;
    const [invitation] = await db.select().from(pendingInvitations).where(eq(pendingInvitations.token, hashToken(token)));
    if (!invitation) return res.status(404).json({ error: "Invitation introuvable" });
    if (invitation.acceptedAt) return res.status(409).json({ error: "Invitation déjà utilisée" });
    if (invitation.expiresAt < new Date()) return res.status(410).json({ error: "Invitation expirée" });
    if (invitation.email !== req.user.email.toLowerCase()) {
      return res.status(403).json({ error: "Cette invitation ne correspond pas à votre compte connecté" });
    }

    // Un compte n'appartient qu'à un seul espace familial à la fois — même
    // règle qu'à la création d'un espace (routes/families.js).
    const [existingMembership] = await db
      .select({ id: familyMemberships.id })
      .from(familyMemberships)
      .where(eq(familyMemberships.userId, req.user.id));
    if (existingMembership) {
      return res.status(409).json({ error: "Vous êtes déjà membre d'un espace familial" });
    }

    // L'auteur doit toujours administrer cet espace (A1 pour un parent).
    const inviter = invitation.invitedByUserId ? await membershipOf(invitation.invitedByUserId, invitation.familyId) : null;
    if (!inviter || inviter.role !== "parent" || (invitation.role === "parent" && !inviter.isPrimaryAdmin)) {
      return res.status(409).json({
        error: `Cette invitation n'est plus valable : la personne qui l'a envoyée n'administre plus cet espace, ${NEW_INVITATION}`,
      });
    }
    if (invitation.role === "parent" && (await parentCount(invitation.familyId)) >= MAX_PARENTS) {
      return res.status(409).json({ error: `Le foyer compte déjà ${MAX_PARENTS} parents : cette invitation ne peut plus être acceptée` });
    }

    // Fiche de l'invité : sa fiche archivée s'il revient, sinon celle prévue
    // (elle a pu être supprimée, archivée ou reliée à un autre compte depuis).
    const [archivedFiche] = await db
      .select()
      .from(members)
      .where(
        and(
          eq(members.familyId, invitation.familyId),
          eq(members.archivedUserId, req.user.id),
          isNotNull(members.archivedAt)
        )
      )
      .orderBy(desc(members.archivedAt))
      .limit(1);
    let linkedFiche = archivedFiche ?? null;
    if (!linkedFiche && invitation.linkedMemberId) {
      const [planned] = await db.select().from(members).where(eq(members.id, invitation.linkedMemberId));
      const [taken] = await db
        .select({ id: familyMemberships.id })
        .from(familyMemberships)
        .where(eq(familyMemberships.linkedMemberId, invitation.linkedMemberId));
      if (planned && !taken && !planned.archivedAt) linkedFiche = planned;
    }
    if (invitation.role === "dependent" && !linkedFiche) {
      return res.status(409).json({ error: `La fiche prévue n'est plus disponible : ${NEW_INVITATION}` });
    }
    if (linkedFiche) {
      const age = ageOn(linkedFiche.dateOfBirth);
      if (invitation.role === "parent" && age !== null && age < ADULT_AGE) {
        return res.status(409).json({ error: MINOR_PARENT_ERROR });
      }
      if (invitation.role !== "parent" && age !== null && age < ACCOUNT_MIN_AGE) {
        return res.status(409).json({ error: UNDER_MIN_AGE_ERROR });
      }
    }
    const inviteeRole = effectiveRole(invitation.role, linkedFiche?.dateOfBirth);

    // Le rôle de dossier prévu est-il encore attribuable ?
    let grantedRole = null;
    if (invitation.documentRole && invitation.documentMemberId !== linkedFiche?.id) {
      const [docFiche] = invitation.documentMemberId
        ? await db.select().from(members).where(eq(members.id, invitation.documentMemberId))
        : [];
      if (!docFiche || docFiche.familyId !== invitation.familyId || docFiche.archivedAt) {
        return res.status(409).json({ error: `Le dossier prévu par l'invitation n'est plus disponible : ${NEW_INVITATION}` });
      }
      if (inviteeRole === "dependent") {
        return res.status(409).json({ error: `${TEEN_ROLE_ERROR} : ${NEW_INVITATION}` });
      }
      if (!(await inviterCanManageRoles(inviter, invitation.familyId, docFiche.id))) {
        return res.status(409).json({ error: `La personne qui vous a invité ne gère plus ce dossier : ${NEW_INVITATION}` });
      }
      grantedRole = { memberId: docFiche.id, role: invitation.documentRole };
    }

    if (archivedFiche) await restoreArchivedFiche(req.user.id, invitation.familyId);
    await db.insert(familyMemberships).values({
      userId: req.user.id,
      familyId: invitation.familyId,
      role: invitation.role,
      linkedMemberId: linkedFiche?.id ?? null,
    });
    // Fiche reliée : les rôles posés avant la liaison tombent (le créateur de
    // la fiche n'en garde pas la gestion), statut et lien « Parent » à jour.
    if (linkedFiche) await afterFicheLinked({ memberId: linkedFiche.id, userId: req.user.id, role: invitation.role });
    await db.update(pendingInvitations).set({ acceptedAt: new Date() }).where(eq(pendingInvitations.id, invitation.id));

    // Le rôle de dossier (Axe 2) fixé avant l'envoi est appliqué maintenant
    // que l'invitation est acceptée (§6.2).
    if (grantedRole) await setDocumentRole(grantedRole.memberId, req.user.id, grantedRole.role);

    // La possession de l'adresse vient d'être prouvée par la consommation de
    // ce lien unique — on active donc l'adresse si ce n'était pas déjà fait.
    if (!req.user.emailVerified) {
      await db.update(users).set({ emailVerified: true }).where(eq(users.id, req.user.id));
    }

    res.json({ success: true, familyId: invitation.familyId, linkedMemberId: linkedFiche?.id ?? null, restored: !!archivedFiche });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
