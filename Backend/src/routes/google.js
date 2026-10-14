import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { pendingInvitations } from "../db/schema.js";
import {
  completeGoogleSignup,
  googleClientId,
  googleIpLimit,
  googleNonceLimit,
  issueNonce,
  openSession,
  rejectGoogleCredential,
  requireGoogleConfigured,
  sessionUser,
  signInWithGoogle,
  verifyGoogleCredential,
} from "../lib/googleAuth.js";
import { sendGoogleWelcomeEmail } from "../lib/mailer.js";
import { logTechnical, requestMeta } from "../lib/technicalLog.js";
import { acceptInvitationRecord } from "./invitations.js";

// « Continuer avec Google » (montées sous /api/auth) : configuration publique,
// nonce, connexion, et confirmation d'une inscription. Règles détaillées dans
// lib/googleAuth.js.
const router = Router();

// Configuration lue par le frontend au chargement des pages de connexion :
// l'identifiant client Google (public par nature) ou null — sans lui, aucun
// bouton Google n'est affiché. Changer GOOGLE_CLIENT_ID ne demande donc pas de
// reconstruire le frontend.
router.get("/config", (req, res) => {
  res.json({ googleClientId: googleClientId() });
});

// Nonce à usage unique, transmis à Google avant l'affichage du bouton.
router.get("/google/nonce", googleNonceLimit, requireGoogleConfigured, (req, res) => {
  res.json({ nonce: issueNonce() });
});

// Connexion : POST { credential } (jeton d'identité reçu du bouton Google).
// Réponse : le compte connecté (cookies de session posés), ou
// { needsSignup, signupToken, name, email } si personne n'a de compte avec
// cet identifiant Google ni cette adresse — le compte n'est PAS créé.
router.post("/google", googleIpLimit, requireGoogleConfigured, async (req, res) => {
  try {
    const verified = await verifyGoogleCredential(req.body?.credential);
    if (!verified.ok) return rejectGoogleCredential(req, res, verified.reason);

    const outcome = await signInWithGoogle(verified.identity, req);
    if (outcome.status) return res.status(outcome.status).json(outcome.body);
    if (outcome.signup) return res.json(outcome.signup);

    await openSession(res, outcome.user);
    await logTechnical({ category: "auth", message: "Connexion Google réussie", metadata: { ...requestMeta(req), userId: outcome.user.id } });
    res.json({ ...sessionUser(outcome.user), googleLinked: outcome.linked });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Confirmation de l'inscription : POST { signupToken, name, accept: true }.
// Crée le compte DÉJÀ VÉRIFIÉ, sans mot de passe, ouvre la session et envoie
// un courriel de bienvenue (sans lien d'activation). Si l'inscription vient
// de « Accepter avec Google », l'invitation est acceptée dans la foulée
// (mêmes vérifications que l'acceptation classique) : résultat dans
// `invitation` ({ status, …réponse de l'acceptation }).
router.post("/google/signup", googleIpLimit, requireGoogleConfigured, async (req, res) => {
  try {
    const { signupToken, name, accept } = req.body ?? {};
    const outcome = await completeGoogleSignup({ signupToken, name, accept }, req);
    if (outcome.status) return res.status(outcome.status).json(outcome.body);

    const { user } = outcome;
    await openSession(res, user);
    await sendGoogleWelcomeEmail({ to: user.email, name: user.name });

    let invitation = null;
    if (outcome.invitationId) {
      const [row] = await db.select().from(pendingInvitations).where(eq(pendingInvitations.id, outcome.invitationId));
      const result = row ? await acceptInvitationRecord(row, user) : { status: 404, body: { error: "Invitation introuvable" } };
      invitation = { status: result.status, ...result.body };
    }
    res.status(201).json({ ...sessionUser(user), invitation });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
