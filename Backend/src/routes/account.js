import { Router } from "express";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  appointments,
  documents,
  emailChangeTokens,
  families,
  familyMemberships,
  members,
  refreshTokens,
  treatmentMedications,
  treatments,
  users,
  vaccinations,
} from "../db/schema.js";
import { comparePassword, hashPassword } from "../lib/password.js";
import { generateToken } from "../lib/token.js";
import { signAccessToken, signRefreshToken, REFRESH_TOKEN_TTL_MS } from "../lib/jwt.js";
import { clearAuthCookies, hashToken, setAuthCookies } from "../lib/session.js";
import { ADULT_AGE, ageOn } from "../lib/family.js";
import { documentFilesOf, removeFiles } from "../lib/documentFiles.js";
import { archiveFicheOfLeavingAccount } from "../lib/archive.js";
import { logActivity } from "../lib/activityLog.js";
import { setDocumentRole } from "../lib/documentAccess.js";
import { soleManagedFiches } from "../lib/management.js";
import { sendEmailChangeEmail, sendEmailChangeNotice, sendPasswordChangedAlert } from "../lib/mailer.js";
import { clearFailures, lockedMinutes, recordFailure, tooManyAttemptsMessage } from "../lib/loginThrottle.js";

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

// Vérifie le mot de passe actuel, avec la même limite de tentatives que la
// connexion (lib/loginThrottle.js) : une session volée ne doit pas servir à
// deviner le mot de passe, puis à changer l'adresse du compte.
async function checkPassword(req, res) {
  const user = await fullUser(req.user.id);
  const minutes = lockedMinutes(user.email, req.ip);
  if (minutes > 0) {
    res.status(429).json({ error: tooManyAttemptsMessage(minutes) });
    return null;
  }
  const ok = typeof req.body.password === "string" && (await comparePassword(req.body.password, user.passwordHash));
  if (!ok) {
    recordFailure(user.email, req.ip);
    res.status(403).json({ error: "Mot de passe actuel incorrect" });
    return null;
  }
  clearFailures(user.email, req.ip);
  return user;
}

// Espaces familiaux du compte, avec ce qui bloquerait sa suppression.
async function membershipsOf(userId) {
  const rows = await db
    .select({ membership: familyMemberships, familyName: families.name })
    .from(familyMemberships)
    .innerJoin(families, eq(families.id, familyMemberships.familyId))
    .where(eq(familyMemberships.userId, userId));
  const out = [];
  for (const { membership, familyName } of rows) {
    const others = await db
      .select({ id: familyMemberships.id })
      .from(familyMemberships)
      .where(and(eq(familyMemberships.familyId, membership.familyId), ne(familyMemberships.userId, userId)));
    out.push({ membership, familyName, otherAccounts: others.length });
  }
  return out;
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

// Suppression du compte. L'administrateur d'un espace qui compte d'autres
// comptes doit d'abord les retirer ou supprimer l'espace ; seul compte d'un
// espace, il supprime l'espace avec lui. Un adulte peut aussi faire effacer
// sa fiche médicale ; sinon elle reste à la famille, archivée (lib/archive.js).
// Les dossiers dont il était le seul gestionnaire sont confiés à A1 (UC-06).
router.delete("/", async (req, res) => {
  try {
    const user = await checkPassword(req, res);
    if (!user) return;
    const spaces = await membershipsOf(user.id);

    const blocking = spaces.filter((s) => s.membership.isPrimaryAdmin && s.otherAccounts > 0);
    if (blocking.length > 0) {
      return res.status(409).json({
        error: `Vous administrez « ${blocking.map((s) => s.familyName).join(" », « ")} », qui compte d'autres comptes : retirez-les ou supprimez l'espace avant de supprimer votre compte.`,
      });
    }

    const familiesToDelete = spaces.filter((s) => s.membership.isPrimaryAdmin).map((s) => s.membership.familyId);
    const memberIdsToDelete = [];
    if (familiesToDelete.length > 0) {
      const rows = await db.select({ id: members.id }).from(members).where(inArray(members.familyId, familiesToDelete));
      memberIdsToDelete.push(...rows.map((r) => r.id));
    }
    if (req.body.deleteMyFiche) {
      for (const { membership } of spaces) {
        if (!membership.linkedMemberId || familiesToDelete.includes(membership.familyId)) continue;
        const [fiche] = await db.select().from(members).where(eq(members.id, membership.linkedMemberId));
        if (fiche && (ageOn(fiche.dateOfBirth) ?? ADULT_AGE) >= ADULT_AGE) memberIdsToDelete.push(fiche.id);
      }
    }

    // Fiches qui restent dans une famille : archivées (gelées, plus lisibles
    // par personne), comme lorsqu'un compte est retiré de l'espace. Le
    // journal de ces familles garde la trace du départ (le nom du compte y
    // reste, suivi de « compte supprimé »).
    //
    // Dossiers dont ce compte était le SEUL gestionnaire (UC-06) : confiés
    // automatiquement à l'Administrateur familial A1, sans lui demander —
    // la personne part d'elle-même, et un dossier géré ne doit jamais rester
    // sans gestionnaire. Une entrée de journal par dossier confié.
    for (const { membership } of spaces) {
      if (familiesToDelete.includes(membership.familyId)) continue;
      const actor = { id: user.id, name: user.name };
      await logActivity({ familyId: membership.familyId, actor, action: "account_deleted" });
      const [a1] = await db
        .select({ userId: familyMemberships.userId })
        .from(familyMemberships)
        .where(and(eq(familyMemberships.familyId, membership.familyId), eq(familyMemberships.isPrimaryAdmin, true)));
      if (a1 && a1.userId !== user.id) {
        for (const fiche of await soleManagedFiches(user.id, membership.familyId)) {
          await setDocumentRole(fiche.id, a1.userId, "gestionnaire");
          await logActivity({
            familyId: membership.familyId,
            actor,
            action: "management_reassigned",
            member: fiche.id,
            target: a1.userId,
            details: { reason: "account_deleted" },
          });
        }
      }
      if (memberIdsToDelete.includes(membership.linkedMemberId)) {
        await logActivity({
          familyId: membership.familyId,
          actor,
          action: "member_deleted",
          member: membership.linkedMemberId,
          details: { withAccount: true },
        });
        continue;
      }
      await archiveFicheOfLeavingAccount(membership, { actor, reason: "account_deleted" });
    }

    const files = await documentFilesOf(memberIdsToDelete);
    if (familiesToDelete.length > 0) await db.delete(families).where(inArray(families.id, familiesToDelete));
    if (memberIdsToDelete.length > 0) await db.delete(members).where(inArray(members.id, memberIdsToDelete));
    await db.delete(users).where(eq(users.id, user.id));
    await removeFiles(files);

    clearAuthCookies(res);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
