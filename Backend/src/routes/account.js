import { Router } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  appointments,
  documents,
  emailChangeTokens,
  members,
  refreshTokens,
  treatmentMedications,
  treatments,
  users,
  vaccinations,
} from "../db/schema.js";
import { hashPassword } from "../lib/password.js";
import { generateToken } from "../lib/token.js";
import { signAccessToken, signRefreshToken, REFRESH_TOKEN_TTL_MS } from "../lib/jwt.js";
import { clearAuthCookies, hashToken, setAuthCookies } from "../lib/session.js";
import { deleteAccount, membershipsOf } from "../lib/accountDeletion.js";
import { SENIOR_MODE_INVALID, setSeniorMode } from "../lib/seniorMode.js";
import { sendEmailChangeEmail, sendEmailChangeNotice, sendPasswordChangedAlert } from "../lib/mailer.js";
// Vérification du mot de passe actuel, avec la limite de tentatives de la
// connexion : commune à « Mon compte » et à l'export de la famille.
import { checkPassword } from "../lib/passwordCheck.js";

// « Mon compte » : profil, mot de passe, adresse courriel, export des
// données et suppression du compte. Chaque action sensible redemande le mot
// de passe actuel.
const router = Router();

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

async function fullUser(id) {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user;
}

router.get("/", async (req, res) => {
  try {
    const user = await fullUser(req.user.id);
    const [pending] = await db
      .select()
      .from(emailChangeTokens)
      .where(and(eq(emailChangeTokens.userId, user.id), isNull(emailChangeTokens.consumedAt)));
    const spaces = await membershipsOf(user.id);
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      pendingEmail: pending && pending.expiresAt > new Date() ? pending.newEmail : null,
      // Affichage (mode senior) : qui l'a réglé en dernier, si c'est un proche.
      seniorMode: user.seniorMode,
      seniorModeSetBy:
        user.seniorModeSetByUserId && user.seniorModeSetByUserId !== user.id
          ? ((await fullUser(user.seniorModeSetByUserId))?.name ?? null)
          : null,
      seniorModeUpdatedAt: user.seniorModeUpdatedAt,
      families: spaces.map((s) => ({
        id: s.membership.familyId,
        name: s.familyName,
        role: s.membership.role,
        isPrimaryAdmin: s.membership.isPrimaryAdmin,
        otherAccounts: s.otherAccounts,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put("/profile", async (req, res) => {
  try {
    const name = String(req.body.name ?? "").trim();
    if (!name || name.length > 150) return res.status(400).json({ error: "Nom requis (150 caractères maximum)" });
    await db.update(users).set({ name }).where(eq(users.id, req.user.id));
    res.json({ name });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Affichage : mode senior (UC-25). Réglage du compte, sans mot de passe
// (aucun enjeu de sécurité ni de droits) ; tracé au journal de ses familles.
router.put("/display", async (req, res) => {
  try {
    const { seniorMode } = req.body ?? {};
    if (typeof seniorMode !== "boolean") return res.status(400).json({ error: SENIOR_MODE_INVALID });
    const result = await setSeniorMode({ actor: req.user, target: req.user, on: seniorMode });
    res.json({ seniorMode: result.seniorMode });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Changement de mot de passe : toutes les sessions sont fermées, puis une
// nouvelle est ouverte pour cet appareil ; une alerte part par courriel.
router.post("/password", async (req, res) => {
  try {
    const user = await checkPassword(req, res);
    if (!user) return;
    const newPassword = req.body.newPassword;
    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Le nouveau mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères` });
    }

    // Arrondi à la seconde : la nouvelle session ouverte juste après reste valable.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    await db.update(users).set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: now }).where(eq(users.id, user.id));
    await db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });
    setAuthCookies(res, accessToken, refreshToken);
    await sendPasswordChangedAlert(user);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Changement d'adresse : un lien de confirmation part vers la nouvelle
// adresse, un avis vers l'ancienne. Rien ne change avant la confirmation.
router.post("/email", async (req, res) => {
  try {
    const user = await checkPassword(req, res);
    if (!user) return;
    const newEmail = String(req.body.newEmail ?? "").toLowerCase().trim();
    if (!EMAIL_RE.test(newEmail) || newEmail.length > 255) return res.status(400).json({ error: "Adresse courriel invalide" });
    if (newEmail === user.email) return res.status(400).json({ error: "C'est déjà l'adresse de votre compte" });
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, newEmail));
    if (taken) return res.status(409).json({ error: "Un compte existe déjà avec cette adresse" });

    const now = new Date();
    await db
      .update(emailChangeTokens)
      .set({ consumedAt: now })
      .where(and(eq(emailChangeTokens.userId, user.id), isNull(emailChangeTokens.consumedAt)));
    const token = generateToken();
    await db.insert(emailChangeTokens).values({
      userId: user.id,
      newEmail,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + EMAIL_CHANGE_TTL_MS),
    });
    await sendEmailChangeEmail({ to: newEmail, name: user.name, token });
    await sendEmailChangeNotice({ to: user.email, name: user.name, newEmail });
    res.json({ pendingEmail: newEmail });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Export « Mes données » : le compte, ses espaces, et le contenu complet de
// sa propre fiche médicale dans chaque espace (fichier JSON).
router.get("/export", async (req, res) => {
  try {
    const user = await fullUser(req.user.id);
    const spaces = await membershipsOf(user.id);
    const fiches = [];
    for (const { membership, familyName } of spaces) {
      if (!membership.linkedMemberId) continue;
      const [member] = await db.select().from(members).where(eq(members.id, membership.linkedMemberId));
      if (!member) continue;
      const ts = await db.select().from(treatments).where(eq(treatments.memberId, member.id));
      const meds = ts.length
        ? await db.select().from(treatmentMedications).where(inArray(treatmentMedications.treatmentId, ts.map((t) => t.id)))
        : [];
      fiches.push({
        famille: familyName,
        fiche: member,
        traitements: ts.map((t) => ({ ...t, medicaments: meds.filter((m) => m.treatmentId === t.id) })),
        vaccinations: await db.select().from(vaccinations).where(eq(vaccinations.memberId, member.id)),
        rendezVous: await db.select().from(appointments).where(eq(appointments.memberId, member.id)),
        documents: (await db.select().from(documents).where(eq(documents.memberId, member.id))).map((d) => ({
          titre: d.title,
          type: d.documentType,
          description: d.description,
          fichierOriginal: d.originalName,
          ajouteLe: d.uploadedAt,
        })),
      });
    }
    const data = {
      exporteLe: new Date().toISOString(),
      compte: { nom: user.name, email: user.email, creeLe: user.createdAt },
      espaces: spaces.map((s) => ({ nom: s.familyName, role: s.membership.role, administrateur: s.membership.isPrimaryAdmin })),
      fiches,
    };
    res.setHeader("Content-Disposition", 'attachment; filename="mes-donnees-sunusante.json"');
    res.type("application/json").send(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Suppression du compte. Règles communes avec la suppression faite par le
// support à la demande de la personne (UC-51) : lib/accountDeletion.js.
router.delete("/", async (req, res) => {
  try {
    const user = await checkPassword(req, res);
    if (!user) return;
    const result = await deleteAccount(user, { deleteMyFiche: Boolean(req.body.deleteMyFiche) });
    if (!result.ok) return res.status(409).json({ error: result.error });
    clearAuthCookies(res);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
