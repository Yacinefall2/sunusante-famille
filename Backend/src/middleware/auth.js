import { eq, and } from "drizzle-orm";
import { verifyAccessToken } from "../lib/jwt.js";
import { db } from "../db/index.js";
import { familyMemberships, members, users } from "../db/schema.js";
import { effectiveRole } from "../lib/family.js";

// Vérifie qu'une session valide (access token) est présente. Va chercher
// l'utilisateur en base à chaque requête (plutôt que de faire confiance aux
// seules informations du jeton) pour que emailVerified reflète toujours
// l'état réel, y compris si l'adresse vient d'être vérifiée dans la même
// session (le jeton d'accès, lui, n'est renouvelé que toutes les 10 minutes).
export async function requireAuth(req, res, next) {
  const token = req.cookies?.access_token;
  if (!token) return res.status(401).json({ error: "Non authentifié" });
  try {
    const payload = verifyAccessToken(token);
    const [user] = await db
      .select({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, payload.sub));
    if (!user) return res.status(401).json({ error: "Non authentifié" });
    req.user = user;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      // Code utilisé par le frontend pour déclencher un rafraîchissement silencieux
      return res.status(401).json({ error: "Session expirée", code: "ACCESS_TOKEN_EXPIRED" });
    }
    return res.status(401).json({ error: "Non authentifié" });
  }
}

// Bloque tout accès tant que l'adresse courriel du compte n'a pas été
// vérifiée — règle transverse §10 "Vérification de l'adresse", sans
// exception, aussi bien pour l'inscription que pour l'invitation. Le compte
// existe mais ne donne accès à rien (ni espace, ni consultation, ni saisie).
export function requireVerifiedEmail(req, res, next) {
  if (!req.user?.emailVerified) {
    return res.status(403).json({
      error: "Adresse courriel non vérifiée. Consultez votre boîte de réception pour activer votre compte.",
      code: "EMAIL_NOT_VERIFIED",
    });
  }
  next();
}

// Vérifie l'appartenance à la famille + le rôle optionnel requis. Attache
// req.familyId et req.membership.
export function requireFamilyMembership(resolveFamilyId, options = {}) {
  return async (req, res, next) => {
    try {
      const familyId = await resolveFamilyId(req);
      if (!familyId) return res.status(400).json({ error: "Famille introuvable" });

      const [membership] = await db
        .select()
        .from(familyMemberships)
        .where(and(eq(familyMemberships.userId, req.user.id), eq(familyMemberships.familyId, familyId)));

      if (!membership) return res.status(403).json({ error: "Accès refusé à cette famille" });

      // Rôle effectif selon l'âge de la fiche du compte (lib/family.js) :
      // toutes les règles d'accès travaillent sur ce rôle, jamais sur le
      // rôle enregistré seul.
      membership.storedRole = membership.role;
      if (membership.role !== "parent" && membership.linkedMemberId) {
        const [fiche] = await db
          .select({ dateOfBirth: members.dateOfBirth })
          .from(members)
          .where(eq(members.id, membership.linkedMemberId));
        membership.role = effectiveRole(membership.role, fiche?.dateOfBirth);
      }

      if (options.roles && !options.roles.includes(membership.role)) {
        return res.status(403).json({ error: "Rôle insuffisant pour cette action" });
      }

      req.familyId = familyId;
      req.membership = membership;
      next();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  };
}