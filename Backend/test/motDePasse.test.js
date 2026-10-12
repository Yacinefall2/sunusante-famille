import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import { passwordResetTokens, refreshTokens, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { MAX_FAILURES } from "../src/lib/loginThrottle.js";
import { buildPasswordResetEmail, sendPasswordResetEmail } from "../src/lib/mailer.js";
import { resetDatabase } from "./helpers.js";

// Mot de passe oublié et limite des tentatives de connexion.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendPasswordResetEmail: vi.fn(async () => {}),
}));

const EMAIL = "awa@test.local";
const PASSWORD = "Ancien-mdp-123";

let user;
beforeEach(async () => {
  vi.mocked(sendPasswordResetEmail).mockClear();
  await resetDatabase();
  [user] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: await hashPassword(PASSWORD), name: "Awa", emailVerified: true })
    .returning();
});

const login = (email, password) => request(app).post("/api/auth/login").send({ email, password });
const forgot = (email) => request(app).post("/api/auth/forgot-password").send({ email });
const reset = (token, password) => request(app).post(`/api/auth/reset-password/${token}`).send({ password });
const sentToken = () => vi.mocked(sendPasswordResetEmail).mock.lastCall[0].token;

describe("Mot de passe oublié", () => {
  it("envoie un lien ; même réponse pour une adresse inconnue", async () => {
    expect((await forgot(" AWA@test.local ")).body).toEqual({ success: true });
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendPasswordResetEmail).mock.lastCall[0]).toMatchObject({ to: EMAIL, name: "Awa" });
    // Seule l'empreinte est stockée.
    const [row] = await db.select().from(passwordResetTokens);
    expect(row.tokenHash).not.toBe(sentToken());

    expect((await forgot("inconnu@test.local")).body).toEqual({ success: true });
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it("le nouveau mot de passe remplace l'ancien et ferme les sessions ouvertes", async () => {
    const session = await login(EMAIL, PASSWORD);
    expect(session.status).toBe(200);
    await forgot(EMAIL);

    const res = await reset(sentToken(), "Nouveau-mdp-456");
    expect(res.status).toBe(200);
    expect((await login(EMAIL, PASSWORD)).status).toBe(401);
    expect((await login(EMAIL, "Nouveau-mdp-456")).status).toBe(200);
    const sessions = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id));
    expect(sessions.filter((s) => s.revokedAt)).toHaveLength(1); // celle d'avant la réinitialisation
  });

  it("lien à usage unique, expirant, remplacé par une nouvelle demande", async () => {
    await forgot(EMAIL);
    const first = sentToken();
    expect((await reset(first, "court")).status).toBe(400); // trop court : le lien reste valable
    expect((await reset(first, "Nouveau-mdp-456")).status).toBe(200);
    expect((await reset(first, "Encore-un-789")).status).toBe(409);

    await db.update(passwordResetTokens).set({ createdAt: new Date(Date.now() - 120000) });
    await forgot(EMAIL);
    const second = sentToken();
    await db.update(passwordResetTokens).set({ createdAt: new Date(Date.now() - 120000) });
    await forgot(EMAIL);
    expect((await reset(second, "Nouveau-mdp-456")).status).toBe(409); // remplacé

    const third = sentToken();
    await db.update(passwordResetTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await reset(third, "Nouveau-mdp-456")).status).toBe(410);
    expect((await reset("inconnu", "Nouveau-mdp-456")).status).toBe(404);
  });

  it("une minute minimum entre deux demandes", async () => {
    await forgot(EMAIL);
    expect((await forgot(EMAIL)).status).toBe(429);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it("courriel : bouton vers la page de réinitialisation, nom échappé", () => {
    const mail = buildPasswordResetEmail({ name: "<b>Awa</b>", token: "abc" });
    expect(mail.html).toContain("/reinitialiser-mot-de-passe/abc");
    expect(mail.html).toContain("Choisir un nouveau mot de passe");
    expect(mail.html).not.toContain("<b>Awa</b>");
  });
});

describe("Limite des tentatives de connexion", () => {
  it(`après ${MAX_FAILURES} échecs, même le bon mot de passe est refusé`, async () => {
    for (let i = 0; i < MAX_FAILURES; i++) expect((await login(EMAIL, "mauvais")).status).toBe(401);
    const blocked = await login(EMAIL, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain("Mot de passe oublié");
  });

  it("une adresse inconnue est limitée de la même façon (rien n'est révélé)", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) expect((await login("inconnu@test.local", "x")).status).toBe(401);
    expect((await login("inconnu@test.local", "x")).status).toBe(429);
  });

  it("une connexion réussie remet le compteur à zéro", async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) await login(EMAIL, "mauvais");
    expect((await login(EMAIL, PASSWORD)).status).toBe(200);
    for (let i = 0; i < MAX_FAILURES - 1; i++) await login(EMAIL, "mauvais");
    expect((await login(EMAIL, PASSWORD)).status).toBe(200);
  });

  it("réinitialiser le mot de passe débloque la connexion", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await login(EMAIL, "mauvais");
    await forgot(EMAIL);
    await reset(sentToken(), "Nouveau-mdp-456");
    expect((await login(EMAIL, "Nouveau-mdp-456")).status).toBe(200);
  });
});
