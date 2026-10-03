import { Router } from "express";
import { eq, and, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { members, familyMemberships, documentRoles, relayTasks } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { canRead, canWriteMember, getFamilyAccess, setDocumentRole } from "../lib/documentAccess.js";

// Axe 3 du modèle d'acteurs — statuts valides pour une fiche membre.
const VALID_STATUSES = ["connecte_autonome", "connecte_assiste", "adolescent", "mineur_gere", "non_connecte"];

// Champs d'identité, visibles de tout le foyer (liste « Membres de la
// famille », §4.5). Tout le reste de la fiche relève du dossier médical.
const IDENTITY_FIELDS = ["id", "familyId", "firstName", "lastName", "avatarColor", "status", "createdAt"];

const router = Router();

function memberValues(body) {
  const { firstName, lastName, dateOfBirth, gender, bloodType, allergies, notes, avatarColor, status } = body;
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    firstName: firstName?.trim(),
    lastName: lastName?.trim(),
    dateOfBirth: dateOfBirth || null,
    gender: gender || null,
    bloodType: bloodType || null,
    allergies: allergies || null,
    notes: notes || null,
    phone: text(body.phone),
    doctorName: text(body.doctorName),
    doctorPhone: text(body.doctorPhone),
    emergencyContactName: text(body.emergencyContactName),
    emergencyContactRelation: text(body.emergencyContactRelation),
    emergencyContactPhone: text(body.emergencyContactPhone),
    avatarColor: avatarColor || "#3B82F6",
    ...(VALID_STATUSES.includes(status) ? { status } : {}),
  };
}

async function linkedMemberIdsOfFamily(familyId) {
  const rows = await db
    .select({ linkedMemberId: familyMemberships.linkedMemberId })
    .from(familyMemberships)
    .where(eq(familyMemberships.familyId, familyId));
  return new Set(rows.map((r) => r.linkedMemberId).filter(Boolean));
}

// Tout le foyer (identité), avec le dossier médical uniquement pour les
// fiches lisibles par ce compte. Chaque fiche porte :
//   access     — "full" | "read" | "relay" | null (voir lib/documentAccess.js)
//   isMine     — fiche reliée au compte connecté (il en est le Titulaire)
//   hasAccount — fiche déjà reliée à un compte de la famille
//   myDocumentRole — rôle de dossier explicite du compte connecté sur la fiche
//                    ("gestionnaire" | "relais" | "lecteur_invite" | null)
router.get(
  "/",
  requireFamilyMembership((req) => parseInt(req.query.familyId) || null),
  async (req, res) => {
    try {
      const all = await db.select().from(members).where(eq(members.familyId, req.familyId)).orderBy(members.id);
      const access = await getFamilyAccess(req);
      const linked = await linkedMemberIdsOfFamily(req.familyId);
      // Badge « À relayer » (§4.5) : rendez-vous à venir d'un proche non
      // connecté que personne n'a encore marqué « Prévenu ». Visible du
      // gestionnaire, et du relais une fois le rappel escaladé vers lui.
      const openTasks = await db
        .select({ memberId: relayTasks.memberId, escalatedAt: relayTasks.escalatedAt })
        .from(relayTasks)
        .where(and(eq(relayTasks.familyId, req.familyId), isNull(relayTasks.notifiedAt), gt(relayTasks.appointmentDate, new Date())));
      const relayPending = (memberId, level) =>
        openTasks.some((t) => t.memberId === memberId && (level === "full" || (level === "relay" && t.escalatedAt)));
      const myRoles = new Map(
        (
          await db
            .select({ memberId: documentRoles.memberId, role: documentRoles.role })
            .from(documentRoles)
            .where(eq(documentRoles.userId, req.user.id))
        ).map((r) => [r.memberId, r.role])
      );
      res.json(
        all.map((m) => {
          const level = access.get(m.id) ?? null;
          const visible = canRead(level) ? m : Object.fromEntries(IDENTITY_FIELDS.map((k) => [k, m[k]]));
          return {
            ...visible,
            access: level,
            isMine: req.membership.linkedMemberId === m.id,
            hasAccount: linked.has(m.id),
            myDocumentRole: myRoles.get(m.id) ?? null,
            relayPending: relayPending(m.id, level),
          };
        })
      );
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Créer une fiche. Avec isMine: true, c'est la fiche de la personne
// elle-même (elle en devient Titulaire) ; sinon celle d'un proche, dont le
// créateur devient Gestionnaire (UC-03, UC-28).
router.post(
  "/",
  requireFamilyMembership((req) => parseInt(req.body.familyId) || null, { roles: ["parent", "adult"] }),
  async (req, res) => {
    try {
      const values = memberValues(req.body);
      if (!values.firstName || !values.lastName) {
        return res.status(400).json({ error: "Données manquantes" });
      }
      const isMine = req.body.isMine === true;
      if (isMine && req.membership.linkedMemberId) {
        return res.status(409).json({ error: "Votre fiche existe déjà" });
      }

      const [created] = await db
        .insert(members)
        .values({ ...values, familyId: req.familyId, status: values.status ?? "connecte_autonome" })
        .returning();

      if (isMine) {
        await db
          .update(familyMemberships)
          .set({ linkedMemberId: created.id })
          .where(eq(familyMemberships.id, req.membership.id));
      } else {
        await setDocumentRole(created.id, req.user.id, "gestionnaire");
      }

      res.status(201).json(created);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Désigner une fiche existante comme « ma fiche » — uniquement une fiche que
// l'on gère déjà (créée par soi) et qui n'est reliée à aucun compte : on ne
// s'attribue jamais le dossier de quelqu'un d'autre. Un Parent peut aussi
// relier un compte à sa fiche depuis la gestion des accès de la famille.
router.post(
  "/claim",
  requireFamilyMembership(async (req) => {
    const id = parseInt(req.body?.id);
    if (!id) return null;
    const [member] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, id));
    return member?.familyId ?? null;
  }),
  async (req, res) => {
    try {
      const memberId = parseInt(req.body.id);
      if (req.membership.linkedMemberId) {
        return res.status(409).json({ error: "Votre fiche existe déjà" });
      }
      if ((await linkedMemberIdsOfFamily(req.familyId)).has(memberId)) {
        return res.status(409).json({ error: "Cette fiche est déjà celle d'un autre compte" });
      }
      const [managed] = await db
        .select({ id: documentRoles.id })
        .from(documentRoles)
        .where(
          and(
            eq(documentRoles.memberId, memberId),
            eq(documentRoles.userId, req.user.id),
            eq(documentRoles.role, "gestionnaire")
          )
        );
      if (!managed) {
        return res.status(403).json({ error: "Vous ne pouvez désigner comme vôtre qu'une fiche que vous gérez" });
      }

      await db.update(familyMemberships).set({ linkedMemberId: memberId }).where(eq(familyMemberships.id, req.membership.id));
      // Titulaire désormais : le rôle Gestionnaire sur sa propre fiche est superflu.
      await db.delete(documentRoles).where(eq(documentRoles.id, managed.id));
      res.json({ success: true, linkedMemberId: memberId });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Résout la famille d'un membre existant à partir de son id (pour PUT/DELETE,
// qui ne reçoivent que l'id du membre, pas familyId)
async function resolveFamilyIdFromMemberId(req) {
  const id = parseInt(req.body?.id ?? req.query?.id);
  if (!id) return null;
  const [member] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, id));
  return member?.familyId ?? null;
}

// Modifier une fiche — accès complet au dossier requis (Titulaire,
// Gestionnaire, Administrateur hors fiche de l'autre administrateur).
router.put("/", requireFamilyMembership(resolveFamilyIdFromMemberId), async (req, res) => {
  try {
    const memberId = parseInt(req.body.id);
    if (!(await canWriteMember(req, memberId))) {
      return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
    }
    const values = memberValues(req.body);
    if (!values.firstName || !values.lastName) {
      return res.status(400).json({ error: "Données manquantes" });
    }
    const [updated] = await db.update(members).set(values).where(eq(members.id, memberId)).returning();
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Supprimer une fiche — réservé aux Administrateurs ayant un accès complet à
// la fiche. La fiche d'un compte de la famille ne se supprime pas ainsi :
// c'est son dossier à lui (retirer d'abord le compte de l'espace).
router.delete(
  "/",
  requireFamilyMembership(resolveFamilyIdFromMemberId, { roles: ["parent"] }),
  async (req, res) => {
    try {
      const id = parseInt(req.query.id ?? "");
      if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });
      if (!(await canWriteMember(req, id))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }
      if ((await linkedMemberIdsOfFamily(req.familyId)).has(id)) {
        return res.status(409).json({
          error: "Cette fiche est celle d'un compte de la famille : retirez d'abord ce compte de l'espace",
        });
      }
      await db.delete(members).where(eq(members.id, id));
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;
