import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import { supportRequests, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { sendSupportConfirmationEmail, sendSupportUpdateEmail } from "../src/lib/mailer.js";
import { resetDatabase, createFamily, addMembership, createUser, as, createSupport, asSupport } from "./helpers.js";

// Demandes au support côté utilisateur : récupération d'accès (UC-50),
// suppression des données (UC-51), signalement d'un compte (UC-52).
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendSupportConfirmationEmail: vi.fn(async () => {}),
  sendSupportUpdateEmail: vi.fn(async () => {}),
}));

const PASSWORD = "Mon-mdp-123";
const DESCRIPTION = "Je n'arrive plus à me connecter depuis que j'ai changé de téléphone.";
let awa, family;

const lastConfirmation = () => vi.mocked(sendSupportConfirmationEmail).mock.lastCall[0];

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  [awa] = await db
    .insert(users)
    .values({ email: "awa@test.local", passwordHash: await hashPassword(PASSWORD), name: "Awa Diop", emailVerified: true })
    .returning();
  family = await createFamily("Diop");
  await addMembership(awa, family, "parent", { isPrimaryAdmin: true });
});

const accessRequest = (body, ip = "198.51.100.7") =>
  request(app).post("/api/support/public/access-request").set("X-Forwarded-For", ip).send(body);

describe("« Je n'arrive plus à accéder à mon compte » (UC-50)", () => {
  it("réponse identique que l'adresse existe ou non (anti-énumération)", async () => {
    const known = await accessRequest({ email: "awa@test.local", description: DESCRIPTION });
    const unknown = await accessRequest({ email: "personne@test.local", description: DESCRIPTION });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    // Seul le compte existant reçoit un lien, à SON adresse.
    expect(sendSupportConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(lastConfirmation().to).toBe("awa@test.local");
    const rows = await db.select().from(supportRequests);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "unverified" && r.type === "recovery")).toBe(true);
    expect(rows.find((r) => r.accountEmail === "personne@test.local").userId).toBeNull();
    expect(rows[0].reference).toMatch(/^SUP-\d{4}-\d{4}$/);
  });

  it("le lien de confirmation fait passer la demande de « non vérifiée » à « ouverte », une seule fois", async () => {
    await accessRequest({ email: "awa@test.local", description: DESCRIPTION, newEmail: "awa.nouvelle@test.local" });
    const { token, reference } = lastConfirmation();
    const confirm = await request(app).post(`/api/support/public/confirm/${token}`);
    expect(confirm.status).toBe(200);
    expect(confirm.body).toMatchObject({ reference, type: "recovery", status: "open" });
    const [row] = await db.select().from(supportRequests);
    expect(row.status).toBe("open");
    expect(row.verifiedAt).not.toBeNull();
    expect(row.newEmail).toBe("awa.nouvelle@test.local");
    // Les réponses du support iront à la nouvelle adresse de contact.
    expect(row.contactEmail).toBe("awa.nouvelle@test.local");
    expect((await request(app).post(`/api/support/public/confirm/${token}`)).status).toBe(409);
    expect((await request(app).post("/api/support/public/confirm/inconnu")).status).toBe(404);
  });

  it("lien expiré : refusé, la demande reste non vérifiée", async () => {
    await accessRequest({ email: "awa@test.local", description: DESCRIPTION });
    const { token } = lastConfirmation();
    await db.update(supportRequests).set({ verificationExpiresAt: new Date(Date.now() - 1000) });
    expect((await request(app).post(`/api/support/public/confirm/${token}`)).status).toBe(410);
    const [row] = await db.select().from(supportRequests);
    expect(row.status).toBe("unverified");
  });

  it("limites : par adresse (en silence) et par adresse IP", async () => {
    for (let i = 0; i < 5; i++) expect((await accessRequest({ email: "awa@test.local", description: DESCRIPTION })).status).toBe(200);
    expect(await db.select().from(supportRequests)).toHaveLength(3);
    let last;
    for (let i = 0; i < 12; i++) last = await accessRequest({ email: `x${i}@test.local`, description: DESCRIPTION }, "198.51.100.99");
    expect(last.status).toBe(429);
  });

  it("valide les champs", async () => {
    expect((await accessRequest({ email: "pas-une-adresse", description: DESCRIPTION })).status).toBe(400);
    expect((await accessRequest({ email: "awa@test.local", description: "court" })).status).toBe(400);
    expect((await accessRequest({ email: "awa@test.local", description: DESCRIPTION, newEmail: "invalide" })).status).toBe(400);
  });
});

describe("« Contacter le support » (UC-51 et autres questions)", () => {
  it("suppression des données : mot de passe exigé, confirmation par lien à l'adresse du compte", async () => {
    const client = as(awa);
    const body = { type: "data_deletion", description: "Je souhaite supprimer mon compte et mes données.", deleteMedicalRecord: true };
    expect((await client.post("/api/support/requests").send({ ...body, password: "faux" })).status).toBe(403);
    expect(sendSupportConfirmationEmail).not.toHaveBeenCalled();

    const res = await client.post("/api/support/requests").send({ ...body, password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: "data_deletion", status: "unverified", deleteMedicalRecord: true, confirmationSent: true });
    expect(lastConfirmation()).toMatchObject({ to: "awa@test.local", type: "data_deletion" });

    expect((await request(app).post(`/api/support/public/confirm/${lastConfirmation().token}`)).status).toBe(200);
    const mine = await client.get("/api/support/requests");
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].status).toBe("open");
  });

  it("autre question : ouverte d'emblée, rattachée au compte", async () => {
    const res = await as(awa).post("/api/support/requests").send({ type: "other", description: "Comment changer la langue de l'application ?" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("open");
    const [row] = await db.select().from(supportRequests);
    expect(row).toMatchObject({ userId: awa.id, requesterUserId: awa.id, contactEmail: "awa@test.local" });
    expect(sendSupportConfirmationEmail).not.toHaveBeenCalled();
  });

  it("type inconnu ou description vide : refusés ; un signalement ne passe pas par ce formulaire", async () => {
    const client = as(awa);
    expect((await client.post("/api/support/requests").send({ type: "report", description: DESCRIPTION })).status).toBe(400);
    expect((await client.post("/api/support/requests").send({ type: "other", description: "" })).status).toBe(400);
  });

  it("échanges : le support répond, la personne est prévenue par courriel et peut répondre", async () => {
    const client = as(awa);
    const created = await client.post("/api/support/requests").send({ type: "other", description: "Question sur les rappels de vaccins." });
    const support = await asSupport((await createSupport()).user);

    const reply = await support.post(`/api/admin/requests/${created.body.id}/reply`).send({ message: "Bonjour, voici la réponse." });
    expect(reply.status).toBe(201);
    expect(vi.mocked(sendSupportUpdateEmail).mock.lastCall[0]).toMatchObject({ to: "awa@test.local", message: "Bonjour, voici la réponse." });

    const answered = await client.post(`/api/support/requests/${created.body.id}/messages`).send({ body: "Merci beaucoup !" });
    expect(answered.status).toBe(201);
    expect(answered.body.messages.map((m) => [m.fromSupport, m.body])).toEqual([
      [true, "Bonjour, voici la réponse."],
      [false, "Merci beaucoup !"],
    ]);
    // Le nom du membre du support n'est pas montré à l'utilisateur.
    expect(answered.body.messages[0].author).toBe("Support SunuSanté Famille");

    // Changement de statut : courriel à la personne ; demande close, plus de réponse.
    await support.post(`/api/admin/requests/${created.body.id}/status`).send({ status: "resolved" });
    expect(vi.mocked(sendSupportUpdateEmail).mock.lastCall[0]).toMatchObject({ to: "awa@test.local", status: "resolved" });
    expect((await client.post(`/api/support/requests/${created.body.id}/messages`).send({ body: "Encore ?" })).status).toBe(409);

    // Personne d'autre ne peut répondre sur cette demande.
    const other = await createUser("Autre");
    expect((await as(other).post(`/api/support/requests/${created.body.id}/messages`).send({ body: "Intrus" })).status).toBe(404);
  });
});

describe("« Signaler un compte » (UC-52)", () => {
  let ousmane, stranger;
  beforeEach(async () => {
    ousmane = await createUser("Ousmane");
    await addMembership(ousmane, family, "adult");
    stranger = await createUser("Étranger");
    await addMembership(stranger, await createFamily("Autre famille"), "parent", { isPrimaryAdmin: true });
  });

  const report = (client, body) =>
    client.post("/api/support/reports").send({ familyId: family.id, reason: "abusive", description: "Messages insultants répétés.", ...body });

  it("signalement d'un compte de sa famille : demande « report » rattachée au compte signalé", async () => {
    const res = await report(as(awa), { targetUserId: ousmane.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: "report", status: "open", reportReason: "abusive" });
    const [row] = await db.select().from(supportRequests);
    expect(row).toMatchObject({ userId: ousmane.id, requesterUserId: awa.id, familyId: family.id, accountEmail: ousmane.email });
    // Le compte signalé n'est pas prévenu : rien dans ses demandes, aucun courriel.
    expect((await as(ousmane).get("/api/support/requests")).body).toEqual([]);
    expect(sendSupportConfirmationEmail).not.toHaveBeenCalled();
    expect(sendSupportUpdateEmail).not.toHaveBeenCalled();
  });

  it("refusé : soi-même, un compte d'une autre famille, une famille dont on n'est pas membre, un motif inconnu", async () => {
    expect((await report(as(awa), { targetUserId: awa.id })).status).toBe(400);
    expect((await report(as(awa), { targetUserId: stranger.id })).status).toBe(404);
    expect((await report(as(stranger), { targetUserId: ousmane.id })).status).toBe(403);
    expect((await report(as(awa), { targetUserId: ousmane.id, reason: "inconnu" })).status).toBe(400);
    expect(await db.select().from(supportRequests)).toHaveLength(0);
  });
});
