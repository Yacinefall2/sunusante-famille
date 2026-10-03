import { Router } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { families, familyMemberships, pendingInvitations, members, users } from "../db/schema.js";
import { requireAuth, requireFamilyMembership, requireVerifiedEmail } from "../middleware/auth.js";
import { generateToken } from "../lib/token.js";
import { sendInvitationEmail } from "../lib/mailer.js";
import { DOCUMENT_ROLES, canManageRoles, canWriteMember, setDocumentRole } from "../lib/documentAccess.js";

const router = Router();

const INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
const ALLOWED_ROLES = ["parent", "adult", "dependent"];
const MAX_PARENTS = 2;

const DOCUMENT_ROLE_LABELS = {
  titulaire: "Titulaire",
  gestionnaire: "Gestionnaire",
  relais: "Relais",
  lecteur_invite: "Lecteur invité",
};

// Créer une invitation — réservé aux Parents. Le rôle d'espace ET le rôle de
// dossier (le cas échéant) sont fixés AVANT l'envoi, jamais après (§6.2/6.3).
router.post(
  "/",
  requireAuth,
  requireVerifiedEmail,
  requireFamilyMembership((req) => parseInt(req.body.familyId) || null, { roles: ["parent"] }),
  async (req, res) => {
    try {
      const { email, role, linkedMemberId, documentMemberId, documentRole } = req.body;
      if (!email?.trim() || !ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({ error: "Email et rôle valides requis" });
      }

      const normalizedEmail = email.toLowerCase().trim();

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
        const parents = await db
          .select()
          .from(familyMemberships)
          .where(and(eq(familyMemberships.familyId, req.familyId), eq(familyMemberships.role, "parent")));
        if (parents.length >= MAX_PARENTS) {
          return res.status(400).json({ error: `Maximum ${MAX_PARENTS} parents par famille` });
        }
      }

      // Fiche de la personne invitée (« sa fiche ») — obligatoire pour un
      // "dependent", optionnelle sinon (l'invité la créera à son arrivée).
      // Elle doit être libre et l'invitant doit en avoir l'accès complet.
      let validatedLinkedMemberId = null;
      if (role === "dependent" && !linkedMemberId) {
        return res.status(400).json({ error: "Choisissez la fiche membre correspondante" });
      }
      if (linkedMemberId) {
        const parsedId = parseInt(linkedMemberId);
        const [member] = await db.select().from(members).where(eq(members.id, parsedId));
        if (!member || member.familyId !== req.familyId) {
          return res.status(400).json({ error: "Fiche membre introuvable dans cette famille" });
        }
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
        validatedLinkedMemberId = parsedId;
      }

      // Rôle Axe 2 (optionnel) — le rôle d'espace ET le rôle de dossier sont
      // fixés avant l'envoi, jamais après (§6.2/6.3). S'il est fourni, la
      // fiche visée doit exister dans cette même famille.
      let validatedDocumentMemberId = null;
      let validatedDocumentRole = null;
      if (documentMemberId || documentRole) {
        if (!documentMemberId || !DOCUMENT_ROLES.includes(documentRole)) {
          return res.status(400).json({ error: "Choisissez un dossier ET un rôle de dossier valides" });
        }
        const parsedDocMemberId = parseInt(documentMemberId);
        const [docMember] = await db.select().from(members).where(eq(members.id, parsedDocMemberId));
        if (!docMember || docMember.familyId !== req.familyId) {
          return res.status(400).json({ error: "Fiche membre introuvable dans cette famille" });
        }
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
          token,
          invitedByUserId: req.user.id,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        })
        .returning();

      let documentMemberName = null;
      if (validatedDocumentMemberId) {
        const [docMember] = await db.select().from(members).where(eq(members.id, validatedDocumentMemberId));
        if (docMember) documentMemberName = `${docMember.firstName} ${docMember.lastName}`;
      }

      await sendInvitationEmail({
        to: normalizedEmail,
        familyName: family.name,
        role,
        token,
        documentMemberName,
        documentRoleLabel: validatedDocumentRole ? DOCUMENT_ROLE_LABELS[validatedDocumentRole] : null,
      });

      res.status(201).json(invitation);
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
  requireFamilyMembership((req) => parseInt(req.query.familyId) || null, { roles: ["parent"] }),
  async (req, res) => {
    try {
      const rows = await db
        .select()
        .from(pendingInvitations)
        .where(and(eq(pendingInvitations.familyId, req.familyId), isNull(pendingInvitations.acceptedAt)));
      res.json(rows);
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
    const [invitation] = await db.select().from(pendingInvitations).where(eq(pendingInvitations.token, token));
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
    const id = parseInt(req.query.id ?? "");
    if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });

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

// Accepter l'invitation — nécessite d'être connecté, ET que l'email du
// compte connecté corresponde exactement à l'email invité (c'est le fait
// d'avoir cliqué le lien reçu par email qui prouve la possession de la boîte).
// Note : contrairement aux autres actions, ceci ne passe PAS par
// requireVerifiedEmail — suivre ce lien unique, envoyé à une adresse précise,
// EST la preuve de possession de cette adresse (§6.2). L'acceptation
// vérifie donc elle-même l'adresse au passage, y compris pour un compte tout
// juste créé via ce même écran.
router.post("/:token/accept", requireAuth, async (req, res) => {
  try {
    const { token } = req.params;
    const [invitation] = await db.select().from(pendingInvitations).where(eq(pendingInvitations.token, token));
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

    // La fiche prévue a pu être reliée à un autre compte depuis l'envoi.
    let linkedMemberId = invitation.linkedMemberId;
    if (linkedMemberId) {
      const [taken] = await db
        .select({ id: familyMemberships.id })
        .from(familyMemberships)
        .where(eq(familyMemberships.linkedMemberId, linkedMemberId));
      if (taken) {
        if (invitation.role === "dependent") {
          return res.status(409).json({ error: "La fiche prévue n'est plus disponible : demandez une nouvelle invitation" });
        }
        linkedMemberId = null;
      }
    }

    await db.insert(familyMemberships).values({
      userId: req.user.id,
      familyId: invitation.familyId,
      role: invitation.role,
      linkedMemberId,
    });
    await db.update(pendingInvitations).set({ acceptedAt: new Date() }).where(eq(pendingInvitations.id, invitation.id));

    // Le rôle de dossier (Axe 2) fixé avant l'envoi est appliqué maintenant
    // que l'invitation est acceptée (§6.2).
    if (invitation.documentMemberId && invitation.documentRole) {
      await setDocumentRole(invitation.documentMemberId, req.user.id, invitation.documentRole);
    }

    // La possession de l'adresse vient d'être prouvée par la consommation de
    // ce lien unique — on active donc l'adresse si ce n'était pas déjà fait.
    if (!req.user.emailVerified) {
      await db.update(users).set({ emailVerified: true }).where(eq(users.id, req.user.id));
    }

    res.json({ success: true, familyId: invitation.familyId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;