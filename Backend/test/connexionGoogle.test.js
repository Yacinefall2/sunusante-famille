import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import { familyMemberships, googleSignupTokens, pendingInvitations, technicalLogs, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { hashToken } from "../src/lib/session.js";
import { setGoogleTokenVerifier } from "../src/lib/googleAuth.js";
import { sendGoogleLinkedEmail, sendGoogleWelcomeEmail, sendPasswordResetEmail } from "../src/lib/mailer.js";
import { resetDatabase, createFamily, addMembership, createUser } from "./helpers.js";

// « Continuer avec Google » : connexion, liaison automatique, inscription
// confirmée, invitations, « Mon compte ». Google n'est JAMAIS appelé : le
// vérificateur de jeton est remplacé par un faux qui lit un jeton en JSON
// (comme si sa signature avait été validée) — les contrôles propres à
// l'application (audience, émetteur, expiration, adresse vérifiée, nonce)
// sont, eux, bien exercés.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendGoogleLinkedEmail: vi.fn(async () => {}),
  sendGoogleWelcomeEmail: vi.fn(async () => {}),
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendPasswordChangedAlert: vi.fn(async () => {}),
}));

const CLIENT_ID = "client-test.apps.googleusercontent.com";
const PASSWORD = "Mon-mdp-123";

setGoogleTokenVerifier(async (token) => {
  if (token === "invalide") throw new Error("Signature invalide");
  return JSON.parse(token);
});
afterAll(() => {
  setGoogleTokenVerifier(null);
  delete process.env.GOOGLE_CLIENT_ID;
});

async function freshNonce() {
  const res = await request(app).get("/api/auth/google/nonce");
  expect(res.status).toBe(200);
  return res.body.nonce;
}

// Jeton d'identité « vérifié » (contenu JSON, lu par le faux vérificateur).
async function credential(overrides = {}) {
  return JSON.stringify({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: "google-sub-awa",
    email: "awa@gmail.com",
    email_verified: true,
    name: "Awa Diop",
    nonce: await freshNonce(),
    ...overrides,
  });
}

async function userWithPassword(email, name = "Awa Diop", extra = {}) {
  const [u] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(PASSWORD), name, emailVerified: true, ...extra })
    .returning();
  return u;
}

const reload = async (id) => (await db.select().from(users).where(eq(users.id, id)))[0];

async function googleLogin(agent, overrides) {
  return agent.post("/api/auth/google").send({ credential: await credential(overrides) });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
});

describe("Configuration", () => {
  it("expose l'identifiant client ; sans GOOGLE_CLIENT_ID, null et routes Google désactivées", async () => {
    expect((await request(app).get("/api/auth/config")).body).toEqual({ googleClientId: CLIENT_ID });

    delete process.env.GOOGLE_CLIENT_ID;
    expect((await request(app).get("/api/auth/config")).body).toEqual({ googleClientId: null });
    expect((await request(app).get("/api/auth/google/nonce")).status).toBe(404);
    expect((await request(app).post("/api/auth/google").send({ credential: "x" })).status).toBe(404);
    expect((await request(app).post("/api/auth/google/signup").send({ signupToken: "x", name: "A", accept: true })).status).toBe(404);
    expect((await request(app).post("/api/invitations/abc/accept-google").send({ credential: "x" })).status).toBe(404);
  });
});

describe("Vérification du jeton", () => {
  it("refuse un jeton invalide, une audience ou un émetteur faux, un jeton expiré, une adresse non vérifiée", async () => {
    const agent = request.agent(app);
    expect((await agent.post("/api/auth/google").send({})).status).toBe(400);
    expect((await agent.post("/api/auth/google").send({ credential: "invalide" })).status).toBe(400);
    expect((await googleLogin(agent, { aud: "autre-client.apps.googleusercontent.com" })).status).toBe(400);
    expect((await googleLogin(agent, { iss: "https://pirate.example" })).status).toBe(400);
    expect((await googleLogin(agent, { exp: Math.floor(Date.now() / 1000) - 10 })).status).toBe(400);
    const unverified = await googleLogin(agent, { email_verified: false });
    expect(unverified.status).toBe(400);
    expect(unverified.body.error).toMatch(/n'est pas vérifiée/);
    // Aucun compte ni jeton d'inscription créé, aucune session ouverte.
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(googleSignupTokens)).toHaveLength(0);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
    // Journal technique : refus notés, sans le jeton.
    const logs = await db.select().from(technicalLogs);
    expect(logs.some((l) => l.message.startsWith("Connexion Google refusée"))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("awa@gmail.com");
  });

  it("nonce : absent, inventé ou déjà utilisé → refus (pas de rejeu)", async () => {
    await userWithPassword("awa@gmail.com", "Awa", { googleSub: "google-sub-awa" });
    const token = await credential();
    expect((await request(app).post("/api/auth/google").send({ credential: token })).status).toBe(200);
    const replay = await request(app).post("/api/auth/google").send({ credential: token });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toMatch(/expiré/);
    expect((await googleLogin(request(app), { nonce: undefined })).status).toBe(400);
    expect((await googleLogin(request(app), { nonce: "abc.9999999999999.faux" })).status).toBe(400);
  });
});

describe("Connexion d'un compte existant", () => {
  it("identifiant Google connu → connexion directe, même si l'adresse Google a changé", async () => {
    const awa = await userWithPassword("awa@exemple.sn", "Awa", { googleSub: "google-sub-awa" });
    const agent = request.agent(app);
    const res = await googleLogin(agent, { email: "nouvelle-adresse@gmail.com" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: awa.id, email: "awa@exemple.sn", emailVerified: true, googleLinked: false });
    expect((await agent.get("/api/auth/me")).body.id).toBe(awa.id);
    expect(sendGoogleLinkedEmail).not.toHaveBeenCalled();
    expect((await reload(awa.id)).lastLoginAt).not.toBeNull();
  });

  it("même adresse → liaison automatique, courriel d'information, session ; le mot de passe reste valable", async () => {
    const awa = await userWithPassword("awa@gmail.com");
    const agent = request.agent(app);
    const res = await googleLogin(agent, { email: "Awa@Gmail.com" });
    expect(res.status).toBe(200);
    expect(res.body.googleLinked).toBe(true);
    const after = await reload(awa.id);
    expect(after.googleSub).toBe("google-sub-awa");
    expect(after.googleLinkedAt).not.toBeNull();
    expect(sendGoogleLinkedEmail).toHaveBeenCalledWith({ to: "awa@gmail.com", name: "Awa Diop" });
    expect((await agent.get("/api/account")).body).toMatchObject({ googleLinked: true, hasPassword: true });
    expect((await request(app).post("/api/auth/login").send({ email: "awa@gmail.com", password: PASSWORD })).status).toBe(200);
  });

  it("adresse jamais vérifiée → liaison, adresse vérifiée, et l'ancien mot de passe (peut-être d'un tiers) effacé", async () => {
    const [squat] = await db
      .insert(users)
      .values({ email: "awa@gmail.com", passwordHash: await hashPassword(PASSWORD), name: "Usurpateur", emailVerified: false })
      .returning();
    const res = await googleLogin(request.agent(app));
    expect(res.status).toBe(200);
    const after = await reload(squat.id);
    expect(after).toMatchObject({ emailVerified: true, passwordHash: null, name: "Awa Diop", googleSub: "google-sub-awa" });
    expect((await request(app).post("/api/auth/login").send({ email: "awa@gmail.com", password: PASSWORD })).status).toBe(401);
  });

  it("compte déjà lié à un AUTRE compte Google → refus clair, rien ne change", async () => {
    const awa = await userWithPassword("awa@gmail.com", "Awa", { googleSub: "autre-sub" });
    const res = await googleLogin(request.agent(app));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/déjà lié à un autre compte Google/);
    expect((await reload(awa.id)).googleSub).toBe("autre-sub");
  });

  it("compte suspendu → même refus que la connexion classique, sans liaison", async () => {
    const awa = await userWithPassword("awa@gmail.com", "Awa", { suspendedAt: new Date(), suspensionReason: "Signalement" });
    const agent = request.agent(app);
    const res = await googleLogin(agent);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
    expect(res.body.error).toMatch(/suspendu/);
    expect((await reload(awa.id)).googleSub).toBeNull();
    expect((await agent.get("/api/auth/me")).status).toBe(401);

    await db.update(users).set({ googleSub: "google-sub-awa" }).where(eq(users.id, awa.id));
    expect((await googleLogin(request.agent(app))).status).toBe(403);
  });
});

describe("Nouveau compte : création avec confirmation", () => {
  it("needsSignup sans création ; confirmation obligatoire ; compte vérifié sans mot de passe ; jeton à usage unique", async () => {
    const first = await googleLogin(request.agent(app));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ needsSignup: true, name: "Awa Diop", email: "awa@gmail.com" });
    expect(first.body.signupToken).toBeTruthy();
    expect(await db.select().from(users)).toHaveLength(0);

    const agent = request.agent(app);
    const signup = (body) => agent.post("/api/auth/google/signup").send({ signupToken: first.body.signupToken, ...body });
    expect((await signup({ name: "Awa D.", accept: false })).status).toBe(400);
    expect((await signup({ name: "Awa D." })).status).toBe(400);
    expect((await signup({ name: " ", accept: true })).status).toBe(400);

    const ok = await signup({ name: " Awa D. ", accept: true });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ name: "Awa D.", email: "awa@gmail.com", emailVerified: true, invitation: null });
    const [created] = await db.select().from(users);
    expect(created).toMatchObject({ emailVerified: true, passwordHash: null, googleSub: "google-sub-awa" });
    expect(sendGoogleWelcomeEmail).toHaveBeenCalledWith({ to: "awa@gmail.com", name: "Awa D." });
    // Session ouverte, accès aux fonctions réservées aux adresses vérifiées.
    expect((await agent.get("/api/account")).body).toMatchObject({ hasPassword: false, googleLinked: true });

    // Usage unique.
    const again = await signup({ name: "Awa", accept: true });
    expect(again.status).toBe(409);
    expect(await db.select().from(users)).toHaveLength(1);
    // Ensuite, simple connexion.
    expect((await googleLogin(request.agent(app))).body.id).toBe(created.id);
  });

  it("jeton d'inscription expiré ou inconnu → refus", async () => {
    const first = await googleLogin(request.agent(app));
    await db.update(googleSignupTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await request(app).post("/api/auth/google/signup").send({ signupToken: first.body.signupToken, name: "Awa", accept: true });
    expect(expired.status).toBe(410);
    const unknown = await request(app).post("/api/auth/google/signup").send({ signupToken: "inconnu", name: "Awa", accept: true });
    expect(unknown.status).toBe(404);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("connexion par mot de passe d'un compte sans mot de passe → message générique", async () => {
    await db.insert(users).values({ email: "awa@gmail.com", passwordHash: null, name: "Awa", emailVerified: true, googleSub: "google-sub-awa" });
    const res = await request(app).post("/api/auth/login").send({ email: "awa@gmail.com", password: "nimporte" });
    const unknown = await request(app).post("/api/auth/login").send({ email: "inconnu@gmail.com", password: "nimporte" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(unknown.body);
    expect(res.body.error).toBe("Identifiants invalides");
  });
});

describe("Invitations : « Accepter avec Google »", () => {
  let family, a1;
  async function invite(email, role = "adult", token = "jeton-invitation-google") {
    await db.insert(pendingInvitations).values({
      familyId: family.id,
      email,
      role,
      token: hashToken(token),
      invitedByUserId: a1.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return token;
  }
  const acceptGoogle = async (agent, token, overrides) =>
    agent.post(`/api/invitations/${token}/accept-google`).send({ credential: await credential(overrides) });

  beforeEach(async () => {
    family = await createFamily("Diop");
    a1 = await createUser("Parent A1");
    await addMembership(a1, family, "parent", { isPrimaryAdmin: true });
  });

  it("même adresse, compte existant → liaison + acceptation avec le rôle fixé à l'émission", async () => {
    const awa = await userWithPassword("awa@gmail.com");
    const token = await invite("awa@gmail.com", "parent");
    const agent = request.agent(app);
    const res = await acceptGoogle(agent, token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, familyId: family.id, user: { id: awa.id } });
    const [membership] = await db.select().from(familyMemberships).where(eq(familyMemberships.userId, awa.id));
    expect(membership.role).toBe("parent");
    expect((await reload(awa.id)).googleSub).toBe("google-sub-awa");
    expect(sendGoogleLinkedEmail).toHaveBeenCalledTimes(1);
    expect((await agent.get("/api/auth/me")).body.id).toBe(awa.id);
  });

  it("autre adresse Google → refus, adresse de l'invitation masquée", async () => {
    const token = await invite("awa@gmail.com");
    const res = await acceptGoogle(request.agent(app), token, { email: "quelquun@gmail.com", sub: "autre" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Cette invitation a été envoyée à a***@gmail.com : connectez-vous avec ce compte Google");
    expect(await db.select().from(googleSignupTokens)).toHaveLength(0);
  });

  it("nouveau compte via l'invitation : confirmation, puis compte créé et invitation acceptée", async () => {
    const token = await invite("awa@gmail.com", "adult");
    const first = await acceptGoogle(request.agent(app), token);
    expect(first.status).toBe(200);
    expect(first.body.needsSignup).toBe(true);
    expect(await db.select().from(users).where(eq(users.email, "awa@gmail.com"))).toHaveLength(0);

    const agent = request.agent(app);
    const res = await agent.post("/api/auth/google/signup").send({ signupToken: first.body.signupToken, name: "Awa Diop", accept: true });
    expect(res.status).toBe(201);
    expect(res.body.invitation).toMatchObject({ status: 200, success: true, familyId: family.id });
    const [membership] = await db.select().from(familyMemberships).where(eq(familyMemberships.userId, res.body.id));
    expect(membership.role).toBe("adult");
    const [invitation] = await db.select().from(pendingInvitations);
    expect(invitation.acceptedAt).not.toBeNull();
  });

  it("les vérifications de l'acceptation classique s'appliquent (limite de 2 parents)", async () => {
    const a2 = await createUser("Parent A2");
    await addMembership(a2, family, "parent");
    await userWithPassword("awa@gmail.com");
    const token = await invite("awa@gmail.com", "parent");
    const res = await acceptGoogle(request.agent(app), token);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/2 parents/);
  });
});

describe("Mon compte : connexion avec Google", () => {
  it("lier depuis Mon compte exige la même adresse ; délier exige un mot de passe", async () => {
    await userWithPassword("awa@gmail.com");
    const agent = request.agent(app);
    expect((await agent.post("/api/auth/login").send({ email: "awa@gmail.com", password: PASSWORD })).status).toBe(200);

    const other = await agent.post("/api/account/google").send({ credential: await credential({ email: "autre@gmail.com" }) });
    expect(other.status).toBe(400);
    const ok = await agent.post("/api/account/google").send({ credential: await credential() });
    expect(ok.status).toBe(200);
    expect(ok.body.googleLinked).toBe(true);
    expect(sendGoogleLinkedEmail).toHaveBeenCalledTimes(1);

    expect((await agent.delete("/api/account/google").send({ password: "faux" })).status).toBe(403);
    const unlinked = await agent.delete("/api/account/google").send({ password: PASSWORD });
    expect(unlinked.status).toBe(200);
    expect((await agent.get("/api/account")).body.googleLinked).toBe(false);
  });

  it("compte sans mot de passe : délier refusé, actions sensibles refusées, « Définir un mot de passe » envoie un lien", async () => {
    await db.insert(users).values({ email: "awa@gmail.com", passwordHash: null, name: "Awa", emailVerified: true, googleSub: "google-sub-awa" });
    const agent = request.agent(app);
    expect((await googleLogin(agent)).status).toBe(200);

    const unlink = await agent.delete("/api/account/google").send({ password: "x" });
    expect(unlink.status).toBe(400);
    expect(unlink.body.error).toMatch(/Définissez d'abord un mot de passe/);

    for (const call of [
      () => agent.post("/api/account/password").send({ password: "x", newPassword: "Nouveau-456" }),
      () => agent.post("/api/account/email").send({ password: "x", newEmail: "awa2@gmail.com" }),
      () => agent.delete("/api/account").send({ password: "x" }),
    ]) {
      const res = await call();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PASSWORD_NOT_SET");
    }

    const setup = await agent.post("/api/account/password-setup");
    expect(setup.status).toBe(200);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendPasswordResetEmail).mock.lastCall[0].to).toBe("awa@gmail.com");
    // Le lien reçu permet de choisir un mot de passe, puis de se connecter avec.
    const resetToken = vi.mocked(sendPasswordResetEmail).mock.lastCall[0].token;
    expect((await request(app).post(`/api/auth/reset-password/${resetToken}`).send({ password: "Nouveau-456" })).status).toBe(200);
    expect((await request(app).post("/api/auth/login").send({ email: "awa@gmail.com", password: "Nouveau-456" })).status).toBe(200);
  });
});
