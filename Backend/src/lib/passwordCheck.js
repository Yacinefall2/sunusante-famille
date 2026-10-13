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
export async function checkPassword(req, res) {
  const [user] = await db.select().from(users).where(eq(users.id, req.user.id));
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
