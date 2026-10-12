import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentRoles, familyMemberships, members, users } from "../db/schema.js";
import { effectiveRole } from "./family.js";

// ── Gestion des dossiers : qui « tient » une fiche (UC-39, UC-06) ────────────
// Une fiche GÉRÉE est une fiche non archivée sans titulaire adulte : aucun
// compte relié (enfant, proche au village…) ou un compte adolescent (les
// parents et gestionnaires gèrent l'adolescent). Une fiche reliée à un compte
// adulte est tenue par son titulaire : sa gestion ne se transfère pas et ne
// se réaffecte pas.

// Comptes de la famille avec leur rôle EFFECTIF (selon l'âge de leur fiche).
export async function familyAccountsWithRole(familyId) {
  const rows = await db
    .select({
      userId: familyMemberships.userId,
      role: familyMemberships.role,
      isPrimaryAdmin: familyMemberships.isPrimaryAdmin,
      linkedMemberId: familyMemberships.linkedMemberId,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      dateOfBirth: members.dateOfBirth,
    })
    .from(familyMemberships)
    .innerJoin(users, eq(users.id, familyMemberships.userId))
    .leftJoin(members, eq(members.id, familyMemberships.linkedMemberId))
    .where(eq(familyMemberships.familyId, familyId));
  return rows.map(({ dateOfBirth, ...r }) => ({ ...r, role: effectiveRole(r.role, dateOfBirth) }));
}

// Comptes à qui la gestion d'un dossier peut être confiée : adultes ou
// parents de la famille — jamais un adolescent —, hors `excludeUserIds`.
export async function managementCandidates(familyId, excludeUserIds = []) {
  return (await familyAccountsWithRole(familyId))
    .filter((a) => a.role !== "dependent" && !excludeUserIds.includes(a.userId))
    .map(({ userId, name, email, role, isPrimaryAdmin }) => ({ userId, name, email, role, isPrimaryAdmin }));
}

// Titulaire d'une fiche ({ userId, role effectif }) ou null.
export async function holderOf(memberId) {
  const [row] = await db
    .select({ userId: familyMemberships.userId, role: familyMemberships.role, dateOfBirth: members.dateOfBirth })
    .from(familyMemberships)
    .innerJoin(members, eq(members.id, familyMemberships.linkedMemberId))
    .where(eq(familyMemberships.linkedMemberId, memberId));
  return row ? { userId: row.userId, role: effectiveRole(row.role, row.dateOfBirth) } : null;
}

// La fiche est-elle gérée (non archivée, sans titulaire adulte) ?
export async function isManagedFiche(fiche) {
  if (!fiche || fiche.archivedAt) return false;
  const holder = await holderOf(fiche.id);
  return !holder || holder.role === "dependent";
}

// Gestionnaires désignés d'une fiche (identifiants de comptes).
export async function managerIdsOf(memberId) {
  const rows = await db
    .select({ userId: documentRoles.userId })
    .from(documentRoles)
    .where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.role, "gestionnaire")));
  return rows.map((r) => r.userId);
}

// Fiches gérées de la famille dont `userId` est le SEUL gestionnaire désigné
// (hors sa propre fiche) : elles doivent être confiées à quelqu'un d'autre
// avant son départ (UC-06). [{ id, firstName, lastName }]
export async function soleManagedFiches(userId, familyId) {
  const mine = await db
    .select({ id: members.id, firstName: members.firstName, lastName: members.lastName, archivedAt: members.archivedAt })
    .from(documentRoles)
    .innerJoin(members, eq(members.id, documentRoles.memberId))
    .where(
      and(
        eq(documentRoles.userId, userId),
        eq(documentRoles.role, "gestionnaire"),
        eq(members.familyId, familyId),
        isNull(members.archivedAt)
      )
    );
  if (mine.length === 0) return [];
  const others = await db
    .select({ memberId: documentRoles.memberId })
    .from(documentRoles)
    .where(
      and(
        inArray(documentRoles.memberId, mine.map((m) => m.id)),
        eq(documentRoles.role, "gestionnaire"),
        ne(documentRoles.userId, userId)
      )
    );
  const managedByOthers = new Set(others.map((o) => o.memberId));
  const result = [];
  for (const fiche of mine) {
    if (managedByOthers.has(fiche.id)) continue;
    const holder = await holderOf(fiche.id);
    if (holder?.userId === userId) continue; // sa propre fiche (archivée à son départ)
    if (holder && holder.role !== "dependent") continue; // tenue par son titulaire adulte
    result.push({ id: fiche.id, firstName: fiche.firstName, lastName: fiche.lastName });
  }
  return result.sort((a, b) => a.id - b.id);
}
