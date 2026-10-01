import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { members } from "../db/schema.js";

// Résout la familyId à partir d'un memberId (utilisé pour les créations,
// où seul le memberId est fourni dans le corps de la requête).
export async function familyIdFromMemberId(memberId) {
  if (!memberId) return null;
  const parsed = parseInt(memberId);
  if (isNaN(parsed)) return null;
  const [member] = await db.select({ familyId: members.familyId }).from(members).where(eq(members.id, parsed));
  return member?.familyId ?? null;
}

// Résout la familyId à partir d'une ligne d'une table liée à members (ex.
// appointments, treatments, vaccinations, documents), en repassant par son
// memberId — utile pour les routes PUT/DELETE qui ne reçoivent qu'un id de
// ressource, sans familyId ni memberId explicite.
export async function familyIdFromResource(table, resourceId) {
  if (!resourceId) return null;
  const parsed = parseInt(resourceId);
  if (isNaN(parsed)) return null;
  const [row] = await db.select({ memberId: table.memberId }).from(table).where(eq(table.id, parsed));
  if (!row) return null;
  return familyIdFromMemberId(row.memberId);
}

// Résout la familyId directement depuis req.query.familyId
export function familyIdFromQuery(req) {
  const id = parseInt(req.query.familyId);
  return isNaN(id) ? null : id;
}