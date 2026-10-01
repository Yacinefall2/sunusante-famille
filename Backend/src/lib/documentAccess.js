import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentRoles, members } from "../db/schema.js";

// Rôles possibles sur un dossier (Axe 2 du modèle d'acteurs).
export const DOCUMENT_ROLES = ["titulaire", "gestionnaire", "relais", "lecteur_invite"];

// Résout le rôle Axe 2 d'un utilisateur sur une fiche membre précise.
// Ordre de résolution :
//   1. Une ligne explicite dans document_roles (le modèle cible).
//   2. À défaut, repli sur members.guardianUserId pour les fiches créées
//      avant l'introduction de document_roles — traité comme "gestionnaire"
//      (droits identiques à "titulaire" dans la matrice modules × rôles,
//      donc aucun comportement existant ne change).
// Renvoie null si l'utilisateur n'a aucun rôle sur ce dossier.
export async function getDocumentRole(memberId, userId) {
  const [explicit] = await db
    .select({ role: documentRoles.role })
    .from(documentRoles)
    .where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.userId, userId)));
  if (explicit) return explicit.role;

  const [member] = await db.select({ guardianUserId: members.guardianUserId }).from(members).where(eq(members.id, memberId));
  if (member?.guardianUserId === userId) return "gestionnaire";

  return null;
}

// Détermine si un utilisateur peut ÉCRIRE (créer/modifier/supprimer) sur le
// dossier d'une fiche membre précise — c'est ce test qui remplace, module par
// module, l'ancien contrôle "role === parent ou adult" valable pour toute la
// famille. Repose sur l'Axe 1 (bypass Admin) et l'Axe 2 (Titulaire/Gestionnaire).
export async function canWriteDocument(memberId, userId, membership) {
  // Axe 3 / Axe 1 — un Dépendant (adolescent, mineur) n'a jamais de droit
  // d'écriture sur un dossier médical (transparence totale, §9.6).
  if (membership.role === "dependent") return false;
  // Axe 1 — un Parent (Administrateur A1 ou Co-administrateur A2) a un accès
  // complet à tous les dossiers du foyer (matrice modules × rôles, M2-M6 : ●).
  if (membership.role === "parent") return true;
  // Axe 2 — sinon, il faut être Titulaire ou Gestionnaire de CE dossier précis.
  const role = await getDocumentRole(memberId, userId);
  return role === "titulaire" || role === "gestionnaire";
}

// Enregistre un rôle Axe 2 pour un utilisateur sur une fiche — remplace
// silencieusement un éventuel rôle déjà attribué à cette même personne sur
// ce même dossier (une personne n'a qu'un seul rôle par dossier à la fois,
// mais peut cumuler des rôles sur des dossiers différents).
export async function setDocumentRole(memberId, userId, role) {
  await db.delete(documentRoles).where(and(eq(documentRoles.memberId, memberId), eq(documentRoles.userId, userId)));
  const [created] = await db.insert(documentRoles).values({ memberId, userId, role }).returning();
  return created;
}