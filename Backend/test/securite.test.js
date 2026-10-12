import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import { emailVerificationTokens, pendingInvitations, refreshTokens, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { DAILY_SEND_LIMIT } from "../src/lib/sendQuota.js";
import { sendAccountExistsEmail, sendInvitationEmail, sendVerificationEmail } from "../src/lib/mailer.js";
import { resetDatabase, createFamily, createUser, addMembership, as } from "./helpers.js";

// Durcissements : inscription sans fuite d'information, sessions, quotas
// d'envoi, jetons stockés sous forme d'empreinte, en-têtes de sécurité.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendAccountExistsEmail: vi.fn(async () => {}),
  sendVerificationEmail: vi.fn(async () => {}),
  sendInvitationEmail: vi.fn(async () => {}),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
});

describe("Inscription", () => {
  it("une adresse déjà inscrite reçoit la même réponse ; la personne est prévenue par courriel", async () => {
    await db.insert(users).values({ email: "awa@test.local", passwordHash: await hashPassword("Mdp-12345"), name: "Awa", emailVerified: true });
    const res = await request(app).post("/api/auth/register").send({ name: "X", email: "awa@test.local", password: "Autre-12345" });
    const fresh = await request(app).post("/api/auth/register").send({ name: "Y", email: "neuf@test.local", password: "Autre-12345" });
    expect(res.status).toBe(fresh.status);
    expect(Object.keys(res.body)).toEqual(Object.keys(fresh.body));
    expect(vi.mocked(sendAccountExistsEmail).mock.lastCall[0].to).toBe("awa@test.local");
    // Le mot de passe existant n'a pas changé.
    expect((await request(app).post("/api/auth/login").send({ email: "awa@test.local", password: "Mdp-12345" })).status).toBe(200);
  });

  it("le jeton de vérification est stocké sous forme d'empreinte et reste utilisable", async () => {
    await request(app).post("/api/auth/register").send({ name: "Y", email: "neuf@test.local", password: "Autre-12345" });
    const token = vi.mocked(sendVerificationEmail).mock.lastCall[0].token;
    const [row] = await db.select().from(emailVerificationTokens);
    expect(row.token).not.toBe(token);
    expect((await request(app).post(`/api/auth/verify-email/${token}`)).status).toBe(200);
  });
});

describe("Sessions", () => {
  beforeEach(async () => {
    await db.insert(users).values({ email: "awa@test.local", passwordHash: await hashPassword("Mdp-12345"), name: "Awa", emailVerified: true });
  });

  it("cookies de session en SameSite=Strict, en-têtes de sécurité présents", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "awa@test.local", password: "Mdp-12345" });
    for (const c of res.headers["set-cookie"]) expect(c).toMatch(/SameSite=Strict/i);
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("un jeton de rafraîchissement remplacé depuis longtemps et rejoué ferme toutes les sessions", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({ email: "awa@test.local", password: "Mdp-12345" });
    const stolen = login.headers["set-cookie"].find((c) => c.startsWith("refresh_token=")).split(";")[0];
    expect((await agent.post("/api/auth/refresh")).status).toBe(200); // rotation normale
    await db.update(refreshTokens).set({ revokedAt: new Date(Date.now() - 5 * 60 * 1000) }).where(eq(refreshTokens.revokedAt, (await db.select().from(refreshTokens))[0].revokedAt));

    const replay = await request(app).post("/api/auth/refresh").set("Cookie", stolen);
    expect(replay.status).toBe(401);
    expect((await agent.post("/api/auth/refresh")).status).toBe(401); // la session légitime est fermée aussi
  });
});

describe("Origine des requêtes", () => {
  it("une modification venue d'un autre site est refusée", async () => {
    await db.insert(users).values({ email: "awa@test.local", passwordHash: await hashPassword("Mdp-12345"), name: "Awa", emailVerified: true });
    const body = { email: "awa@test.local", password: "Mdp-12345" };
    expect((await request(app).post("/api/auth/login").set("Origin", "https://pirate.exemple").send(body)).status).toBe(403);
    expect((await request(app).post("/api/auth/login").set("Origin", new URL(process.env.FRONTEND_URL || "http://localhost:5173").origin).send(body)).status).toBe(200);
  });
});

describe("Invitations", () => {
  it("jeton jamais renvoyé ni stocké en clair ; adresse validée ; quota quotidien", async () => {
    const family = await createFamily("Fall");
    const parent = await createUser("Parent");
    await addMembership(parent, family, "parent", { isPrimaryAdmin: true });
    const invite = (email) => as(parent).post("/api/invitations").send({ familyId: family.id, email, role: "adult" });

    expect((await invite("pas une adresse")).status).toBe(400);
    const res = await invite("moussa@test.local");
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("token");
    const token = vi.mocked(sendInvitationEmail).mock.lastCall[0].token;
    const [row] = await db.select().from(pendingInvitations);
    expect(row.token).not.toBe(token);
    expect((await request(app).get(`/api/invitations/${token}`)).status).toBe(200);
    const list = await as(parent).get(`/api/invitations?familyId=${family.id}`);
    expect(list.body[0]).not.toHaveProperty("token");

    for (let i = 1; i < DAILY_SEND_LIMIT; i++) await invite(`invite${i}@test.local`);
    expect((await invite("en-trop@test.local")).status).toBe(429);
  });
});
