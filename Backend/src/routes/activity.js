import { Router } from "express";
import { and, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { activityLog, members } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { getFamilyAccess } from "../lib/documentAccess.js";
import { ALWAYS_VISIBLE_TO_PARENTS, CATEGORIES, actionsOfCategory, fullName, presentEntries } from "../lib/activityLog.js";
import { familyIdFromQuery } from "../lib/familyResolvers.js";
import { isIsoDate, parseId } from "../lib/validation.js";
import { addDays, zonedTime } from "../lib/time.js";

// ── Journal d'activité (UC-10, §10 « Traçabilité ») ──────────────────────────
// Lecture seule : aucune route ne modifie ni ne supprime une entrée.
//
// Qui voit quoi (calculé ICI, jamais côté client) :
//   - un parent (A1, A2) : tout le journal de la famille — les événements
//     sans fiche (espace, invitations…) et ceux des fiches auxquelles il a
//     accès ; donc PAS ceux de la fiche de l'autre parent (même règle de
//     réciprocité que les dossiers, §10), ni ceux d'une fiche archivée ou
//     supprimée. Exception : archivage, restauration et suppression d'une
//     fiche restent toujours visibles (sans détail du dossier) ;
//   - tout autre compte (adulte, adolescent, relais, lecteur invité) :
//     seulement l'activité sur sa propre fiche (« Activité sur mon dossier »).
const router = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// Curseur de pagination : « <instant ISO>_<id> » de la dernière entrée reçue.
function parseCursor(value) {
  if (typeof value !== "string") return null;
  const [iso, rawId] = value.split("_");
  const at = new Date(iso);
  const id = parseId(rawId);
  return Number.isNaN(at.getTime()) || !id ? null : { at, id };
}
const cursorOf = (row) => `${row.occurredAt.toISOString()}_${row.id}`;

router.get("/", requireFamilyMembership(familyIdFromQuery), async (req, res) => {
  try {
    const isParent = req.membership.role === "parent";
    const ownFiche = req.membership.linkedMemberId ?? null;
    const conditions = [eq(activityLog.familyId, req.familyId)];

    // Fiches dont le journal est lisible par ce compte.
    let visibleFiches;
    if (isParent) {
      visibleFiches = [...(await getFamilyAccess(req)).keys()];
      conditions.push(
        or(
          isNull(activityLog.memberId),
          visibleFiches.length > 0 ? inArray(activityLog.memberId, visibleFiches) : undefined,
          inArray(activityLog.action, ALWAYS_VISIBLE_TO_PARENTS)
        )
      );
    } else {
      // Sans fiche reliée : rien à montrer.
      visibleFiches = ownFiche ? [ownFiche] : [];
      if (!ownFiche) return res.json({ entries: [], nextCursor: null, scope: "mine", members: [], categories: CATEGORIES });
      conditions.push(eq(activityLog.memberId, ownFiche));
    }

    // Filtres
    if (req.query.memberId) {
      const memberId = parseId(req.query.memberId);
      if (!memberId) return res.status(400).json({ error: "Fiche invalide" });
      conditions.push(eq(activityLog.memberId, memberId));
    }
    if (req.query.category) {
      if (!CATEGORIES[req.query.category]) return res.status(400).json({ error: "Catégorie inconnue" });
      conditions.push(inArray(activityLog.action, actionsOfCategory(req.query.category)));
    }
    // Période : jours entiers dans le fuseau de l'application.
    if (req.query.from) {
      if (!isIsoDate(req.query.from)) return res.status(400).json({ error: "Date de début invalide" });
      conditions.push(gte(activityLog.occurredAt, zonedTime(req.query.from, "00:00")));
    }
    if (req.query.to) {
      if (!isIsoDate(req.query.to)) return res.status(400).json({ error: "Date de fin invalide" });
      conditions.push(lt(activityLog.occurredAt, zonedTime(addDays(req.query.to, 1), "00:00")));
    }
    if (req.query.before) {
      const cursor = parseCursor(req.query.before);
      if (!cursor) return res.status(400).json({ error: "Curseur invalide" });
      conditions.push(
        or(lt(activityLog.occurredAt, cursor.at), and(eq(activityLog.occurredAt, cursor.at), lt(activityLog.id, cursor.id)))
      );
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    const rows = await db
      .select()
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(desc(activityLog.occurredAt), desc(activityLog.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);

    // Fiches proposées dans le filtre : celles dont le journal est lisible.
    const ficheRows =
      visibleFiches.length > 0
        ? await db
            .select({ id: members.id, firstName: members.firstName, lastName: members.lastName })
            .from(members)
            .where(inArray(members.id, visibleFiches))
            .orderBy(members.id)
        : [];

    res.json({
      entries: await presentEntries(page),
      nextCursor: rows.length > limit ? cursorOf(page[page.length - 1]) : null,
      scope: isParent ? "family" : "mine",
      members: ficheRows.map((m) => ({ id: m.id, name: fullName(m) })),
      categories: CATEGORIES,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
