import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import { documents, families, members, treatments, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { sendEmailChangeEmail, sendEmailChangeNotice, sendPasswordChangedAlert } from "../src/lib/mailer.js";
import { resetDatabase, createFamily, addMembership, createMember, linkMember, createUser } from "./helpers.js";

// « Mon compte » : profil, mot de passe, adresse, export, suppression.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendPasswordChangedAlert: vi.fn(async () => {}),
  sendEmailChangeEmail: vi.fn(async () => {}),
  sendEmailChangeNotice: vi.fn(async () => {}),
}));

const PASSWORD = "Mon-mdp-123";
let awa, family, fiche;

async function userWithPassword(email, name) {
  const [u] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(PASSWORD), name, emailVerified: true })
    .returning();
  return u;
}

async function loggedIn(email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return agent;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  awa = await userWithPassword("awa@test.local", "Awa Diop");
  family = await createFamily("Diop");
  const m = await addMembership(awa, family, "parent", { isPrimaryAdmin: true });
  fiche = await createMember(family, "Awa");
  await db.update(members).set({ dateOfBirth: "1985-03-02", allergies: "Pénicilline" }).where(eq(members.id, fiche.id));
  await linkMember(m, fiche);
  await db.insert(treatments).values({ memberId: fiche.id, disease: "Hypertension" });
});

describe("Profil et mot de passe", () => {
  it("modifier son nom", async () => {
    const agent = await loggedIn("awa@test.local");
    expect((await agent.put("/api/account/profile").send({ name: "  Awa Fall " })).body.name).toBe("Awa Fall");
    expect((await agent.put("/api/account/profile").send({ name: " " })).status).toBe(400);
  });

  it("changer de mot de passe exige l'actuel, ferme les autres sessions et envoie une alerte", async () => {
    const ici = await loggedIn("awa@test.local");
    const ailleurs = await loggedIn("awa@test.local");
    expect((await ici.post("/api/account/password").send({ password: "faux", newPassword: "Nouveau-456" })).status).toBe(403);
    expect((await ici.post("/api/account/password").send({ password: PASSWORD, newPassword: "court" })).status).toBe(400);

    // Les jetons émis dans la même seconde que le changement resteraient valides : on attend la seconde suivante.
    await new Promise((r) => setTimeout(r, 1100));
    expect((await ici.post("/api/account/password").send({ password: PASSWORD, newPassword: "Nouveau-456" })).status).toBe(200);
    expect(sendPasswordChangedAlert).toHaveBeenCalledTimes(1);

    expect((await ici.get("/api/account")).status).toBe(200); // cet appareil reste connecté
    expect((await ailleurs.get("/api/account")).status).toBe(401); // l'autre est déconnecté…
    expect((await ailleurs.post("/api/auth/refresh")).status).toBe(401); // …sans pouvoir se rafraîchir
    expect((await request(app).post("/api/auth/login").send({ email: "awa@test.local", password: "Nouveau-456" })).status).toBe(200);
  });
});

describe("Changement d'adresse", () => {
  const confirmToken = () => vi.mocked(sendEmailChangeEmail).mock.lastCall[0].token;

  it("l'adresse ne change qu'après confirmation par le lien envoyé à la nouvelle", async () => {
    const agent = await loggedIn("awa@test.local");
    const res = await agent.post("/api/account/email").send({ password: PASSWORD, newEmail: "Awa.Diop@Exemple.SN" });
    expect(res.body.pendingEmail).toBe("awa.diop@exemple.sn");
    expect(vi.mocked(sendEmailChangeEmail).mock.lastCall[0].to).toBe("awa.diop@exemple.sn");
    expect(vi.mocked(sendEmailChangeNotice).mock.lastCall[0]).toMatchObject({ to: "awa@test.local", newEmail: "awa.diop@exemple.sn" });
    expect((await agent.get("/api/account")).body).toMatchObject({ email: "awa@test.local", pendingEmail: "awa.diop@exemple.sn" });

    const token = confirmToken();
    expect((await request(app).post(`/api/auth/confirm-email-change/${token}`)).status).toBe(200);
    expect((await request(app).post(`/api/auth/confirm-email-change/${token}`)).status).toBe(409);
    expect((await agent.get("/api/account")).body).toMatchObject({ email: "awa.diop@exemple.sn", pendingEmail: null });
    expect((await request(app).post("/api/auth/login").send({ email: "awa.diop@exemple.sn", password: PASSWORD })).status).toBe(200);
  });

  it("mot de passe requis, adresse déjà prise refusée", async () => {
    await userWithPassword("pris@test.local", "Autre");
    const agent = await loggedIn("awa@test.local");
    expect((await agent.post("/api/account/email").send({ password: "faux", newEmail: "x@test.local" })).status).toBe(403);
    expect((await agent.post("/api/account/email").send({ password: PASSWORD, newEmail: "pris@test.local" })).status).toBe(409);
    expect((await agent.post("/api/account/email").send({ password: PASSWORD, newEmail: "pas-une-adresse" })).status).toBe(400);
    expect(sendEmailChangeEmail).not.toHaveBeenCalled();
  });
});

describe("Export des données", () => {
  it("contient le compte et la fiche complète, en pièce jointe", async () => {
    const agent = await loggedIn("awa@test.local");
    const res = await agent.get("/api/account/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    const data = JSON.parse(res.text);
    expect(data.compte.email).toBe("awa@test.local");
    expect(data.fiches[0].fiche.allergies).toBe("Pénicilline");
    expect(data.fiches[0].traitements[0].disease).toBe("Hypertension");
    expect(res.text).not.toContain("passwordHash");
  });
});

describe("Suppression du compte", () => {
  it("seul compte de son espace : l'espace et ses fichiers partent avec lui", async () => {
    await db.insert(documents).values({ memberId: fiche.id, title: "Radio", documentType: "radio" });
    const agent = await loggedIn("awa@test.local");
    expect((await agent.delete("/api/account").send({ password: "faux" })).status).toBe(403);
    expect((await agent.delete("/api/account").send({ password: PASSWORD })).status).toBe(200);
    expect(await db.select().from(users).where(eq(users.id, awa.id))).toHaveLength(0);
    expect(await db.select().from(families)).toHaveLength(0);
    expect(await db.select().from(members)).toHaveLength(0);
    expect((await request(app).post("/api/auth/login").send({ email: "awa@test.local", password: PASSWORD })).status).toBe(401);
  });

  it("administrateur d'un espace avec d'autres comptes : refusé", async () => {
    await addMembership(await createUser("Moussa"), family, "adult");
    const agent = await loggedIn("awa@test.local");
    const res = await agent.delete("/api/account").send({ password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Diop");
  });

  it("simple membre : sa fiche reste à la famille, sauf s'il demande à l'effacer", async () => {
    const moussa = await userWithPassword("moussa@test.local", "Moussa");
    const m = await addMembership(moussa, family, "adult");
    const ficheMoussa = await createMember(family, "Moussa");
    await db.update(members).set({ dateOfBirth: "1990-01-01" }).where(eq(members.id, ficheMoussa.id));
    await linkMember(m, ficheMoussa);

    expect((await (await loggedIn("moussa@test.local")).delete("/api/account").send({ password: PASSWORD })).status).toBe(200);
    expect(await db.select().from(members).where(eq(members.id, ficheMoussa.id))).toHaveLength(1);
    expect(await db.select().from(families)).toHaveLength(1);

    const fatou = await userWithPassword("fatou@test.local", "Fatou");
    const f = await addMembership(fatou, family, "adult");
    const ficheFatou = await createMember(family, "Fatou");
    await db.update(members).set({ dateOfBirth: "1992-01-01" }).where(eq(members.id, ficheFatou.id));
    await linkMember(f, ficheFatou);
    const agent = await loggedIn("fatou@test.local");
    expect((await agent.delete("/api/account").send({ password: PASSWORD, deleteMyFiche: true })).status).toBe(200);
    expect(await db.select().from(members).where(eq(members.id, ficheFatou.id))).toHaveLength(0);
    expect(await db.select().from(members).where(eq(members.id, fiche.id))).toHaveLength(1); // celle d'Awa reste
  });
});
