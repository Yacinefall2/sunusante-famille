import { Router } from "express";
import { eq, and, gt, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { members, familyMemberships, documentRoles, relayTasks, users, appointments } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { canRead, canWriteMember, getFamilyAccess, setDocumentRole } from "../lib/documentAccess.js";
import {
  ACCOUNT_MIN_AGE,
  ADULT_AGE,
  GENDERS,
  KINSHIPS,
  MINOR_PARENT_ERROR,
  UNDER_MIN_AGE_ERROR,
  ageOn,
  effectiveRole,
  statusForLinkedFiche,
} from "../lib/family.js";
import { documentFilesOf, removeFiles } from "../lib/documentFiles.js";
import { ARCHIVED_ERROR, afterFicheLinked } from "../lib/archive.js";
import { familyIdFromBody, familyIdFromQuery } from "../lib/familyResolvers.js";
import { INVALID_ID, isIsoDate, parseId, tooLong } from "../lib/validation.js";
import { localDate } from "../lib/time.js";

// Axe 3 du modèle d'acteurs — statuts valides pour une fiche membre.
const VALID_STATUSES = ["connecte_autonome", "connecte_assiste", "adolescent", "mineur_gere", "non_connecte"];

// Champs d'identité, visibles de tout le foyer (liste « Membres de la
// famille », §4.5). Tout le reste de la fiche relève du dossier médical.
// Le sexe, la date de naissance et le lien de parenté en font partie : ils
// servent à afficher à chacun « petit frère, 8 ans », « grand-mère »…
const IDENTITY_FIELDS = [
  "id",
  "familyId",
  "firstName",
  "lastName",
  "avatarColor",
  "status",
  "createdAt",
  "gender",
  "dateOfBirth",
  "kinship",
  "kinshipRelatedMemberId",
];

const router = Router();

function memberValues(body) {
  const { firstName, lastName, dateOfBirth, gender, bloodType, allergies, notes, avatarColor, status } = body;
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const str = (v) => (typeof v === "string" && v ? v : null);
  return {
    kinship: str(body.kinship),
    kinshipRelatedMemberId: parseId(body.kinshipRelatedMemberId),
    firstName: typeof firstName === "string" ? firstName.trim() : undefined,
    lastName: typeof lastName === "string" ? lastName.trim() : undefined,
    dateOfBirth: str(dateOfBirth),
    gender: str(gender),
    bloodType: str(bloodType),
    allergies: str(allergies),
    notes: str(notes),
    phone: text(body.phone),
    doctorName: text(body.doctorName),
    doctorPhone: text(body.doctorPhone),
    emergencyContactName: text(body.emergencyContactName),
    emergencyContactRelation: text(body.emergencyContactRelation),
    emergencyContactPhone: text(body.emergencyContactPhone),
    avatarColor: str(avatarColor) || "#3B82F6",
    ...(VALID_STATUSES.includes(status) ? { status } : {}),
  };
}

// Longueurs maximales des champs de la fiche (varchar de db/schema.js).
function tooLongFiche(values) {
  return tooLong([
    [values.firstName, 100, "Prénom"],
    [values.lastName, 100, "Nom"],
    [values.bloodType, 10, "Groupe sanguin"],
    [values.phone, 30, "Téléphone"],
    [values.doctorName, 150, "Médecin traitant"],
    [values.doctorPhone, 30, "Téléphone du médecin"],
    [values.emergencyContactName, 150, "Contact d'urgence"],
    [values.emergencyContactRelation, 60, "Lien du contact d'urgence"],
    [values.emergencyContactPhone, 30, "Téléphone du contact d'urgence"],
    [values.avatarColor, 20, "Couleur"],
  ]);
}

// Comptes de la famille, avec leur rôle dans l'espace (Axe 1).
async function familyAccounts(familyId) {
  return db
    .select({
      userId: users.id,
      name: users.name,
      role: familyMemberships.role,
      isPrimaryAdmin: familyMemberships.isPrimaryAdmin,
      linkedMemberId: familyMemberships.linkedMemberId,
    })
    .from(familyMemberships)
    .innerJoin(users, eq(users.id, familyMemberships.userId))
    .where(eq(familyMemberships.familyId, familyId));
}

const publicAccount = (a, dateOfBirth = null) =>
  a ? { userId: a.userId, name: a.name, role: effectiveRole(a.role, dateOfBirth), isPrimaryAdmin: a.isPrimaryAdmin } : null;

// Le foyer, sans ambiguïté entre membres et comptes : un MEMBRE est une
// personne de la famille (avec sa fiche) ; un COMPTE est un accès à
// l'application. Renvoie les comptes pas encore reliés à une fiche (invités
// qui n'ont pas encore créé « Ma fiche ») et les deux totaux. Les fiches
// archivées ne comptent plus parmi les membres.
router.get(
  "/household",
  requireFamilyMembership(familyIdFromQuery),
  async (req, res) => {
    try {
      const [{ count }] = await db
        .select({ count: sql`count(*)::int` })
        .from(members)
        .where(and(eq(members.familyId, req.familyId), isNull(members.archivedAt)));
      const accounts = await familyAccounts(req.familyId);
      res.json({
        membersCount: count,
        accountsCount: accounts.length,
        accountsWithoutFiche: accounts.filter((a) => !a.linkedMemberId).map((a) => publicAccount(a)),
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Contrôle commun à la création et à la modification d'une fiche : identité
// complète (date de naissance, sexe, lien de parenté), lien « parent »
// réservé aux administrateurs, règle des 15 ans pour la fiche d'un compte,
// jamais de parent mineur. Complète `values` (lien forcé à « parent » pour
// un administrateur). `owner` : compte relié à la fiche (modification).
async function checkFiche(req, values, { ficheId = null, isMine = false, owner = null } = {}) {
  if (!values.firstName || !values.lastName) return "Prénom et nom requis";
  const long = tooLongFiche(values);
  if (long) return long;
  if (!isIsoDate(values.dateOfBirth) || values.dateOfBirth > localDate()) {
    return "Date de naissance requise (elle détermine l'âge et le lien affiché)";
  }
  if (!GENDERS.includes(values.gender)) return "Sexe requis";

  const ownerRole = isMine ? req.membership.storedRole : owner?.role;
  if (ownerRole === "parent") {
    if (ageOn(values.dateOfBirth) < ADULT_AGE) return MINOR_PARENT_ERROR;
    values.kinship = "parent";
    values.kinshipRelatedMemberId = null;
  } else {
    if (!KINSHIPS.includes(values.kinship)) return "Lien de parenté requis";
    if (values.kinship === "parent") return "Le lien « Parent » est réservé aux administrateurs du foyer";
    if ((isMine || owner) && ageOn(values.dateOfBirth) < ACCOUNT_MIN_AGE) return UNDER_MIN_AGE_ERROR;
  }
  if (values.kinshipRelatedMemberId) {
    const [related] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, values.kinshipRelatedMemberId));
    if (!related || related.familyId !== req.familyId || values.kinshipRelatedMemberId === ficheId) {
      values.kinshipRelatedMemberId = null;
    }
  }
  return null;
}

// Date de naissance d'une fiche reliée à un compte : elle fixe les droits de
// ce compte (adolescent / adulte), donc elle ne se change pas librement.
//   - sur sa propre fiche, un adulte (ou un parent) la corrige tant qu'il
//     reste majeur ;
//   - la fiche d'un parent : seulement par ce parent ;
//   - la fiche d'un autre compte : seulement par un parent, et sans faire
//     changer le rôle effectif du compte (adulte ↔ adolescent) — sauf
//     l'Administrateur familial A1, qui peut tout faire.
// Renvoie { status, error } ou null.
function birthDateChangeError(req, owner, existing, newDate) {
  if (owner.userId === req.user.id) {
    if (ageOn(newDate) < ADULT_AGE) {
      return { status: 400, error: "Votre fiche doit rester celle d'un adulte : demandez à l'administrateur familial" };
    }
    return null;
  }
  if (owner.role === "parent") {
    return { status: 403, error: "Seul ce parent peut modifier sa propre date de naissance" };
  }
  if (req.membership.role !== "parent") {
    return { status: 403, error: "Seul un parent peut modifier la date de naissance d'une personne qui a son propre compte" };
  }
  if (req.membership.isPrimaryAdmin) return null;
  if (effectiveRole(owner.role, existing.dateOfBirth) !== effectiveRole(owner.role, newDate)) {
    return {
      status: 400,
      error: "Le changement de date de naissance modifierait les droits de ce compte : demandez à l'administrateur familial",
    };
  }
  return null;
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
//   account    — ce compte (nom, rôle dans la famille) ou null : un membre
//                peut ne pas avoir de compte (enfant, proche au village)
//   myDocumentRole — rôle de dossier explicite du compte connecté sur la fiche
//                    ("gestionnaire" | "relais" | "lecteur_invite" | null)
//   archived   — fiche archivée (titulaire parti) : seuls le prénom et le
//                nom sont renvoyés, sans aucune autre donnée
router.get(
  "/",
  requireFamilyMembership(familyIdFromQuery),
  async (req, res) => {
    try {
      const all = await db.select().from(members).where(eq(members.familyId, req.familyId)).orderBy(members.id);
      const access = await getFamilyAccess(req);
      const accounts = await familyAccounts(req.familyId);
      const accountByFiche = new Map(accounts.filter((a) => a.linkedMemberId).map((a) => [a.linkedMemberId, a]));
      // Badge « À relayer » (§4.5) : rendez-vous à venir d'un proche non
      // connecté que personne n'a encore marqué « Prévenu ». Visible du
      // gestionnaire, et du relais une fois le rappel escaladé vers lui. Une
      // tâche dont le rendez-vous a été annulé ou déplacé ne compte plus
      // (même règle que villageTick).
      const openTasks = await db
        .select({ memberId: relayTasks.memberId, escalatedAt: relayTasks.escalatedAt })
        .from(relayTasks)
        .innerJoin(appointments, eq(appointments.id, relayTasks.appointmentId))
        .where(
          and(
            eq(relayTasks.familyId, req.familyId),
            isNull(relayTasks.notifiedAt),
            gt(relayTasks.appointmentDate, new Date()),
            ne(appointments.status, "cancelled"),
            eq(appointments.appointmentDate, relayTasks.appointmentDate)
          )
        );
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
          if (m.archivedAt) {
            return {
              id: m.id,
              familyId: m.familyId,
              firstName: m.firstName,
              lastName: m.lastName,
              archived: true,
              access: null,
              isMine: false,
              hasAccount: false,
              account: null,
              myDocumentRole: null,
              relayPending: false,
            };
          }
          const level = access.get(m.id) ?? null;
          const { archivedAt: _a, archivedUserId: _u, ...fiche } = m;
          const visible = canRead(level) ? fiche : Object.fromEntries(IDENTITY_FIELDS.map((k) => [k, m[k]]));
          return {
            ...visible,
            archived: false,
            access: level,
            isMine: req.membership.linkedMemberId === m.id,
            hasAccount: accountByFiche.has(m.id),
            // Rôle effectif : un compte de moins de 18 ans est « dependent ».
            account: publicAccount(accountByFiche.get(m.id), m.dateOfBirth),
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
// créateur devient Gestionnaire (UC-03, UC-28) — rôle retiré dès que la
// fiche est reliée au compte de la personne (lib/archive.js afterFicheLinked).
router.post(
  "/",
  requireFamilyMembership(familyIdFromBody, { roles: ["parent", "adult"] }),
  async (req, res) => {
    try {
      const values = memberValues(req.body);
      const isMine = req.body.isMine === true;
      if (isMine && req.membership.linkedMemberId) {
        return res.status(409).json({ error: "Votre fiche existe déjà" });
      }
      const invalid = await checkFiche(req, values, { isMine });
      if (invalid) return res.status(400).json({ error: invalid });

      const status = isMine
        ? statusForLinkedFiche(req.membership.storedRole, values.dateOfBirth, values.status)
        : values.status ?? "connecte_autonome";
      const [created] = await db
        .insert(members)
        .values({ ...values, familyId: req.familyId, status })
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
// l'on gère déjà (créée par soi, ou dont on est gestionnaire), qui n'est
// reliée à aucun compte et n'est pas archivée : on ne s'attribue jamais le
// dossier de quelqu'un d'autre. Mêmes règles d'âge que les invitations (pas
// de compte avant 15 ans) ; un parent ne s'approprie pas la fiche d'un
// enfant de moins de 18 ans.
router.post(
  "/claim",
  requireFamilyMembership(async (req) => {
    const id = parseId(req.body?.id);
    if (!id) return null;
    const [member] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, id));
    return member?.familyId ?? null;
  }),
  async (req, res) => {
    try {
      const memberId = parseId(req.body.id);
      if (req.membership.linkedMemberId) {
        return res.status(409).json({ error: "Votre fiche existe déjà" });
      }
      const [fiche] = await db.select().from(members).where(eq(members.id, memberId));
      if (fiche.archivedAt) return res.status(409).json({ error: ARCHIVED_ERROR });
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

      const age = ageOn(fiche.dateOfBirth);
      if (age !== null && age < ACCOUNT_MIN_AGE) return res.status(400).json({ error: UNDER_MIN_AGE_ERROR });
      if (req.membership.storedRole === "parent" && age !== null && age < ADULT_AGE) {
        return res.status(400).json({
          error: `Cette fiche est celle d'un mineur : un parent ne peut pas la désigner comme la sienne`,
        });
      }
      await db.update(familyMemberships).set({ linkedMemberId: memberId }).where(eq(familyMemberships.id, req.membership.id));
      // Titulaire désormais : les rôles de dossier posés avant (dont le sien,
      // superflu) tombent ; statut et lien « Parent » mis à jour.
      await afterFicheLinked({ memberId, userId: req.user.id, role: req.membership.storedRole });
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
  const id = parseId(req.body?.id ?? req.query?.id);
  if (!id) return null;
  const [member] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, id));
  return member?.familyId ?? null;
}

// Modifier une fiche — accès complet au dossier requis (Titulaire,
// Gestionnaire, Administrateur hors fiche de l'autre administrateur). Une
// fiche archivée n'est accessible à personne.
router.put("/", requireFamilyMembership(resolveFamilyIdFromMemberId), async (req, res) => {
  try {
    const memberId = parseId(req.body.id);
    if (!(await canWriteMember(req, memberId))) {
      return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
    }
    const [existing] = await db.select().from(members).where(eq(members.id, memberId));
    const [owner] = await db.select().from(familyMemberships).where(eq(familyMemberships.linkedMemberId, memberId));
    const values = memberValues(req.body);
    const invalid = await checkFiche(req, values, { ficheId: memberId, owner });
    if (invalid) return res.status(400).json({ error: invalid });
    if (owner && values.dateOfBirth !== existing.dateOfBirth) {
      const refused = birthDateChangeError(req, owner, existing, values.dateOfBirth);
      if (refused) return res.status(refused.status).json({ error: refused.error });
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
// c'est son dossier à lui (retirer d'abord le compte de l'espace). Une fiche
// archivée ne peut être supprimée (définitivement) que par l'Administrateur
// familial A1.
router.delete(
  "/",
  requireFamilyMembership(resolveFamilyIdFromMemberId, { roles: ["parent"] }),
  async (req, res) => {
    try {
      const id = parseId(req.query.id);
      if (!id) return res.status(400).json({ error: INVALID_ID });
      const [fiche] = await db.select().from(members).where(eq(members.id, id));
      if (!fiche) return res.status(404).json({ error: "Fiche introuvable" });
      if (fiche.archivedAt) {
        if (!req.membership.isPrimaryAdmin) {
          return res.status(403).json({ error: "Seul l'administrateur familial peut supprimer une fiche archivée" });
        }
      } else {
        if (!(await canWriteMember(req, id))) {
          return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
        }
        if ((await linkedMemberIdsOfFamily(req.familyId)).has(id)) {
          return res.status(409).json({
            error: "Cette fiche est celle d'un compte de la famille : retirez d'abord ce compte de l'espace",
          });
        }
      }
      const files = await documentFilesOf([id]);
      await db.delete(members).where(eq(members.id, id));
      await removeFiles(files);
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;
