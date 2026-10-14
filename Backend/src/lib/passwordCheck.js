import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { comparePassword } from "./password.js";
import { clearFailures, lockedMinutes, recordFailure, tooManyAttemptsMessage } from "./loginThrottle.js";

// Vérifie le mot de passe actuel (req.body.password) avant une action
// sensible — « Mon compte », export des données de la famille —, avec la même
// limite de tentatives que la connexion (lib/loginThrottle.js) : une session
// volée ne doit pas servir à deviner le mot de passe.
// Renvoie le compte complet, ou null après avoir répondu (403 ou 429).
//
// Compte SANS mot de passe (créé avec « Continuer avec Google ») : ces actions
// sensibles sont refusées tant qu'aucun mot de passe n'est défini (« Mon
// compte » → « Définir un mot de passe », lien envoyé à l'adresse du compte).
// Choix volontairement simple et sûr : pas de ré-authentification Google à
// la volée ; le lien reçu par courriel prouve la possession de la boîte.
export const PASSWORD_NOT_SET =
  "Votre compte n'a pas encore de mot de passe (connexion avec Google). Définissez-en un depuis « Mon compte » → « Connexion avec Google », puis recommencez.";

export async function checkPassword(req, res) {
  const [user] = await db.select().from(users).where(eq(users.id, req.user.id));
  if (!user.passwordHash) {
    res.status(403).json({ error: PASSWORD_NOT_SET, code: "PASSWORD_NOT_SET" });
    return null;
  }
  const minutes = lockedMinutes(user.email, req.ip);
  if (minutes > 0) {
    res.status(429).json({ error: tooManyAttemptsMessage(minutes) });
    return null;
  }
  const ok = typeof req.body?.password === "string" && (await comparePassword(req.body.password, user.passwordHash));
  if (!ok) {
    recordFailure(user.email, req.ip);
    res.status(403).json({ error: "Mot de passe actuel incorrect" });
    return null;
  }
  clearFailures(user.email, req.ip);
  return user;
}
