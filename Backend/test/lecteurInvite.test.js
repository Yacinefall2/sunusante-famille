import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { documentRoles, notifications, users } from "../src/db/schema.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { sendInvitationEmail } from "../src/lib/mailer.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, grantRole, attest, as } from "./helpers.js";

// R4 Lecteur invité : « consultation seule, durée limitée » — durée
// obligatoire, accès coupé à l'échéance, avertissement 3 jours avant,
// prolongation en un clic.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendInvitationEmail: vi.fn(async () => {}),
}));

const DAY = 24 * 3600 * 1000;
const tick = (now) => runReminderTick({ now, sendMail: async () => "<id@test>" });
const notifsOf = (user, category = "role_expiry") =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, user.id), eq(notifications.category, category)));
const roleOf = async (fiche, user) =>
  (
    await db
      .select()
      .from(documentRoles)
      .where(and(eq(documentRoles.memberId, fiche.id), eq(documentRoles.userId, user.id)))
  )[0] ?? null;
const near = (date, expected) => expect(Math.abs(new Date(date).getTime() - expected)).toBeLessThan(60_000);

// Foyer Diallo : Aïssatou (A1), Binta (titulaire de sa fiche), Cheikh
// (gestionnaire de Grand-mère, sans compte), Lamine (futur lecteur invité).
let f;
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  const family = await createFamily("Diallo");
  const [aissatou, binta, cheikh, lamine] = await Promise.all(["Aïssatou", "Binta", "Cheikh", "Lamine"].map((n) => createUser(n)));
  const aM = await addMembership(aissatou, family, "parent", { isPrimaryAdmin: true });
  const bM = await addMembership(binta, family, "adult");
  const cM = await addMembership(cheikh, family, "adult");
  const lM = await addMembership(lamine, family, "adult");
  await linkMember(aM, await createMember(family, "Aïssatou"));
  const bintaFiche = await createMember(family, "Binta");
  await linkMember(bM, bintaFiche);
  await linkMember(cM, await createMember(family, "Cheikh"));
  await linkMember(lM, await createMember(family, "Lamine"));
  const grandMere = await createMember(family, "Grand-mère");
  await grantRole(grandMere, cheikh, "gestionnaire");
  f = { family, aissatou, binta, cheikh, lamine, bintaFiche, grandMere };
});

const grant = (by, fiche, user, extra = {}) =>
  as(by).post("/api/document-roles").send({ memberId: fiche.id, userId: user.id, role: "lecteur_invite", ...extra });

describe("Durée obligatoire", () => {
  it("attribution sans durée ou avec une durée inconnue : refusée (400)", async () => {
    expect((await grant(f.binta, f.bintaFiche, f.lamine)).status).toBe(400);
    expect((await grant(f.binta, f.bintaFiche, f.lamine, { duration: "2j" })).status).toBe(400);
    expect(await roleOf(f.bintaFiche, f.lamine)).toBeNull();
  });

  it("attribution avec une durée : échéance enregistrée et affichée dans la liste des rôles", async () => {
    const res = await grant(f.binta, f.bintaFiche, f.lamine, { duration: "7j" });
    expect(res.status).toBe(201);
    near(res.body.expiresAt, Date.now() + 7 * DAY);
    const list = (await as(f.binta).get(`/api/document-roles?memberId=${f.bintaFiche.id}`)).body;
    near(list[0].expiresAt, Date.now() + 7 * DAY);
    // Les autres rôles n'ont pas d'échéance.
    const g = await as(f.binta).post("/api/document-roles").send({ memberId: f.bintaFiche.id, userId: f.cheikh.id, role: "gestionnaire" });
    expect(g.status).toBe(201);
    expect(g.body.expiresAt).toBeNull();
    // « 3 mois » : mois calendaires.
    const m3 = await grant(f.aissatou, f.grandMere, f.lamine, { duration: "3m" });
    const expected = new Date();
    expected.setUTCMonth(expected.getUTCMonth() + 3);
    near(m3.body.expiresAt, expected.getTime());
  });

  it("invitation avec le rôle de lecteur invité : durée obligatoire, échéance à l'acceptation", async () => {
    await attest(f.grandMere, f.cheikh); // accord oral du proche (UC-29)
    const base = { familyId: f.family.id, email: "invite@test.local", role: "member", documentMemberId: f.grandMere.id, documentRole: "lecteur_invite" };
    expect((await as(f.aissatou).post("/api/invitations").send(base)).status).toBe(400);
    const res = await as(f.aissatou).post("/api/invitations").send({ ...base, documentRoleDuration: "30j" });
    expect(res.status).toBe(201);
    expect(res.body.documentRoleDuration).toBe("30j");
    const token = vi.mocked(sendInvitationEmail).mock.lastCall[0].token;
    expect(vi.mocked(sendInvitationEmail).mock.lastCall[0].documentRoleDuration).toBe("30j");

    const invitee = await createUser("Invité");
    await db.update(users).set({ email: "invite@test.local" }).where(eq(users.id, invitee.id));
    expect((await as({ ...invitee, email: "invite@test.local" }).post(`/api/invitations/${token}/accept`)).status).toBe(200);
    near((await roleOf(f.grandMere, invitee)).expiresAt, Date.now() + 30 * DAY);
  });
});

describe("Échéance", () => {
  it("accès coupé dès l'échéance, puis rôle supprimé par le worker et journalisé", async () => {
    await grant(f.binta, f.bintaFiche, f.lamine, { duration: "7j" });
    expect((await as(f.lamine).get(`/api/treatments?memberId=${f.bintaFiche.id}`)).status).toBe(200);

    // Échéance passée : le moteur d'accès ignore le rôle, avant même le worker.
    await db.update(documentRoles).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(documentRoles.userId, f.lamine.id));
    expect((await as(f.lamine).get(`/api/treatments?memberId=${f.bintaFiche.id}`)).status).toBe(403);

    await tick(new Date());
    expect(await roleOf(f.bintaFiche, f.lamine)).toBeNull();
    const texts = (await as(f.aissatou).get(`/api/activity?familyId=${f.family.id}&category=roles`)).body.entries.map((e) => e.text);
    // Entrée visible des parents (A1 lit la fiche de Binta).
    expect(texts).toContain("Accès de lecteur invité expiré : Lamine ne consulte plus le dossier de Binta Test");
  });

  it("le worker (now simulé) coupe l'accès à l'échéance", async () => {
    await grant(f.binta, f.bintaFiche, f.lamine, { duration: "7j" });
    await tick(new Date(Date.now() + 6 * DAY));
    expect(await roleOf(f.bintaFiche, f.lamine)).not.toBeNull();
    await tick(new Date(Date.now() + 7 * DAY + 60_000));
    expect(await roleOf(f.bintaFiche, f.lamine)).toBeNull();
    expect((await as(f.lamine).get(`/api/treatments?memberId=${f.bintaFiche.id}`)).status).toBe(403);
  });

  it("avertissement 3 jours avant, au lecteur et au titulaire — une seule fois", async () => {
    await grant(f.binta, f.bintaFiche, f.lamine, { duration: "7j" });
    await tick(new Date(Date.now() + 3 * DAY)); // 4 jours avant : rien
    expect(await notifsOf(f.lamine)).toHaveLength(0);

    await tick(new Date(Date.now() + 4.5 * DAY)); // 2,5 jours avant
    await tick(new Date(Date.now() + 5 * DAY));
    const reader = await notifsOf(f.lamine);
    expect(reader).toHaveLength(1);
    expect(reader[0].title).toBe("Votre accès au dossier de Binta Test prend fin bientôt");
    const holder = await notifsOf(f.binta);
    expect(holder).toHaveLength(1);
    expect(holder[0].title).toMatch(/^L'accès de Lamine au dossier de Binta Test prend fin le /);
    expect(holder[0].link).toBe(`/fiches?fiche=${f.bintaFiche.id}`);
    // Ni A1 ni le gestionnaire d'une autre fiche.
    expect(await notifsOf(f.aissatou)).toHaveLength(0);
  });

  it("sans titulaire, ce sont les gestionnaires qui sont prévenus", async () => {
    await grant(f.aissatou, f.grandMere, f.lamine, { duration: "7j" });
    await tick(new Date(Date.now() + 5 * DAY));
    expect(await notifsOf(f.lamine)).toHaveLength(1);
    expect(await notifsOf(f.cheikh)).toHaveLength(1);
  });
});

describe("Prolongation en un clic", () => {
  it("par qui gère les rôles de la fiche : l'échéance recule, c'est journalisé, un nouvel avertissement est possible", async () => {
    const { body } = await grant(f.binta, f.bintaFiche, f.lamine, { duration: "7j" });
    await tick(new Date(Date.now() + 5 * DAY));
    expect(await notifsOf(f.lamine)).toHaveLength(1);

    // Le lecteur lui-même ne peut pas se prolonger ; durée obligatoire.
    expect((await as(f.lamine).post(`/api/document-roles/${body.id}/extend`).send({ duration: "30j" })).status).toBe(403);
    expect((await as(f.binta).post(`/api/document-roles/${body.id}/extend`).send({})).status).toBe(400);

    const res = await as(f.binta).post(`/api/document-roles/${body.id}/extend`).send({ duration: "30j" });
    expect(res.status).toBe(200);
    near(res.body.expiresAt, new Date(body.expiresAt).getTime() + 30 * DAY);

    // Le nouvel avertissement vient 3 jours avant la nouvelle échéance.
    await tick(new Date(Date.now() + 6 * DAY));
    expect(await notifsOf(f.lamine)).toHaveLength(1);
    await tick(new Date(Date.now() + 35 * DAY));
    expect(await notifsOf(f.lamine)).toHaveLength(2);
    expect(await roleOf(f.bintaFiche, f.lamine)).not.toBeNull();

    const texts = (await as(f.binta).get(`/api/activity?familyId=${f.family.id}&category=roles`)).body.entries.map((e) => e.text);
    expect(texts[0]).toMatch(/^Binta a prolongé de 30 jours l'accès de lecteur invité de Lamine au dossier de Binta Test \(accès jusqu'au \d{2}\/\d{2}\/\d{4}\)$/);
  });

  it("seul un accès de lecteur invité se prolonge", async () => {
    const g = await as(f.binta).post("/api/document-roles").send({ memberId: f.bintaFiche.id, userId: f.cheikh.id, role: "gestionnaire" });
    expect((await as(f.binta).post(`/api/document-roles/${g.body.id}/extend`).send({ duration: "7j" })).status).toBe(400);
  });
});
