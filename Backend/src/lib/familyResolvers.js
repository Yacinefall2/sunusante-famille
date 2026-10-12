import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { members } from "../db/schema.js";
import { parseId } from "./validation.js";

// Les identifiants mal formés (texte, nombre trop grand pour la base…) ne
// résolvent aucune famille : la requête est refusée en 400 par
// requireFamilyMembership, sans jamais atteindre PostgreSQL.

// Résout la familyId à partir d'un memberId (utilisé pour les créations,
// où seul le memberId est fourni dans le corps de la requête).
export async function familyIdFromMemberId(memberId) {
  const parsed = parseId(memberId);
  if (!parsed) return null;
  const [member] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, parsed));
  return member?.familyId ?? null;
}

// Résout la familyId à partir d'une ligne d'une table liée à members (ex.
// appointments, treatments, vaccinations, documents), en repassant par son
// memberId — utile pour les routes PUT/DELETE qui ne reçoivent qu'un id de
// ressource, sans familyId ni memberId explicite.
export async function familyIdFromResource(table, resourceId) {
  const parsed = parseId(resourceId);
  if (!parsed) return null;
  const [row] = await db.select({ memberId: table.memberId }).from(table).where(eq(table.id, parsed));
  if (!row) return null;
  return familyIdFromMemberId(row.memberId);
}

// Résout la familyId des routes de liste (GET ?familyId=… ou ?memberId=…).
// Quand un memberId est fourni, c'est TOUJOURS la famille de cette fiche qui
// est retenue (le familyId éventuel est ignoré) : l'appartenance est donc
// vérifiée sur la famille de la fiche réellement lue. Sans cette règle, un
// appel ?familyId=<ma famille>&memberId=<fiche d'une autre famille> passait
// le contrôle d'appartenance et renvoyait les données de l'autre famille.
export async function familyIdForListQuery(req) {
  if (req.query.memberId) return familyIdFromMemberId(req.query.memberId);
  return familyIdFromQuery(req);
}

// Résout la familyId directement depuis req.query.familyId
export function familyIdFromQuery(req) {
  return parseId(req.query.familyId);
}

// Même chose depuis le corps de la requête (créations).
export function familyIdFromBody(req) {
  return parseId(req.body?.familyId);
}
