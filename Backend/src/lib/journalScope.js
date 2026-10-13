import { eq, inArray, isNull, or } from "drizzle-orm";
import { activityLog } from "../db/schema.js";
import { getFamilyAccess } from "./documentAccess.js";
import { ALWAYS_VISIBLE_TO_PARENTS } from "./activityLog.js";

// Partie du journal d'activité visible par un compte (UC-10, §10) — règle
// commune à la page Journal (routes/activity.js) et à l'export de la famille
// (lib/familyExport.js) :
//   - un parent (A1, A2) : les événements sans fiche (espace, invitations…)
//     et ceux des fiches auxquelles il a accès ; donc PAS ceux de la fiche de
//     l'autre parent, ni ceux d'une fiche archivée ou supprimée. Exception :
//     archivage, restauration et suppression d'une fiche restent visibles ;
//   - tout autre compte : seulement l'activité sur sa propre fiche.
// `req` : requête (ou contexte équivalent) avec user, familyId et membership.
// Renvoie { scope, visibleFiches, condition } ; condition vaut null quand le
// compte n'a rien à voir (aucune fiche reliée).
export async function journalScope(req) {
  const familyCondition = eq(activityLog.familyId, req.familyId);
  if (req.membership.role === "parent") {
    const visibleFiches = [...(await getFamilyAccess(req)).keys()];
    return {
      scope: "family",
      visibleFiches,
      condition: [
        familyCondition,
        or(
          isNull(activityLog.memberId),
          visibleFiches.length > 0 ? inArray(activityLog.memberId, visibleFiches) : undefined,
          inArray(activityLog.action, ALWAYS_VISIBLE_TO_PARENTS)
        ),
      ],
    };
  }
  const ownFiche = req.membership.linkedMemberId ?? null;
  if (!ownFiche) return { scope: "mine", visibleFiches: [], condition: null };
  return { scope: "mine", visibleFiches: [ownFiche], condition: [familyCondition, eq(activityLog.memberId, ownFiche)] };
}
