import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { appointments, documentRoles, members, notifications, pendingInvitations } from "../src/db/schema.js";
import { sendInvitationEmail } from "../src/lib/mailer.js";
import { ageOn } from "../src/lib/family.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { resetDatabase, createUser, createFamily, addMembership, linkMember, grantRole, attest, attestation, as } from "./helpers.js";

// Courriels d'invitation interceptés : le jeton est relu dans l'appel.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendInvitationEmail: vi.fn(async () => {}),
}));

const yearsAgo = (y) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - y);
  d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
};

// Fiche complète (identité exigée par l'API).
async function fiche(family, firstName, dateOfBirth, extra = {}) {
  const [m] = await db
    .insert(members)
    .values({ familyId: family.id, firstName, lastName: "Diallo", dateOfBirth, gender: "F", kinship: "autre", ...extra })
    .returning();
  return m;
}

const identity = (m, dateOfBirth = m.dateOfBirth) => ({
  id: m.id,
  firstName: m.firstName,
  lastName: m.lastName,
  dateOfBirth,
  gender: m.gender,
  kinship: m.kinship === "parent" ? "autre" : m.kinship,
});

// Envoie une invitation par l'API et renvoie { res, token }.
async function invite(by, family, body) {
  vi.mocked(sendInvitationEmail).mockClear();
  const res = await as(by).post("/api/invitations").send({ familyId: family.id, ...body });
  const call = vi.mocked(sendInvitationEmail).mock.lastCall;
  return { res, token: call?.[0].token };
}
const accept = (user, token) => as(user).post(`/api/invitations/${token}/accept`);
const rolesOn = (m) => db.select().from(documentRoles).where(eq(documentRoles.memberId, m.id));
const listed = async (user, family, m) => (await as(user).get(`/api/members?familyId=${family.id}`)).body.find((x) => x.id === m.id);

let f;
beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Diallo");
  const a1 = await createUser("Awa");
  const a1M = await addMembership(a1, family, "parent", { isPrimaryAdmin: true });
  await linkMember(a1M, await fiche(family, "Awa", "1980-03-01", { kinship: "parent" }));
  f = { family, a1, a1M };
});

describe("Point 1 — le créateur d'une fiche n'en garde pas la gestion une fois reliée", () => {
  it("A1 crée la fiche de son conjoint puis l'invite comme parent : plus aucun accès à son dossier", async () => {
    const created = await as(f.a1).post("/api/members").send({ familyId: f.family.id, firstName: "Moussa", lastName: "Diallo", dateOfBirth: "1978-06-01", gender: "M", kinship: "autre", consent: attestation(f.a1) });
    expect(created.status).toBe(201);
    await db.update(members).set({ allergies: "Pénicilline" }).where(eq(members.id, created.body.id));
    expect(await rolesOn(created.body)).toHaveLength(1); // A1 gestionnaire tant que la fiche est sans compte

    const moussa = await createUser("Moussa");
    const { res, token } = await invite(f.a1, f.family, { email: moussa.email, role: "parent", linkedMemberId: created.body.id });
    expect(res.status).toBe(201);
    expect((await accept(moussa, token)).status).toBe(200);

    expect(await rolesOn(created.body)).toHaveLength(0);
    const seen = await listed(f.a1, f.family, created.body);
    expect(seen.access).toBeNull();
    expect(seen).not.toHaveProperty("allergies");
    expect((await as(f.a1).get(`/api/treatments?memberId=${created.body.id}`)).status).toBe(403);
    expect(seen.kinship).toBe("parent");
    expect((await listed(moussa, f.family, created.body)).access).toBe("full");
  });

  it("un adulte crée la fiche de son frère ; une fois le frère invité et relié, il ne la gère plus", async () => {
    const fatou = await createUser("Fatou");
    await linkMember(await addMembership(fatou, f.family, "adult"), await fiche(f.family, "Fatou", "1995-01-01"));
    const created = await as(fatou).post("/api/members").send({ familyId: f.family.id, firstName: "Ibou", lastName: "Diallo", dateOfBirth: "1999-02-02", gender: "M", kinship: "autre", status: "non_connecte", consent: attestation(fatou) });
    expect((await listed(fatou, f.family, created.body)).access).toBe("full");

    const ibou = await createUser("Ibou");
    const { token } = await invite(f.a1, f.family, { email: ibou.email, role: "member", linkedMemberId: created.body.id });
    expect((await accept(ibou, token)).status).toBe(200);

    expect((await listed(fatou, f.family, created.body)).access).toBeNull();
    const [after] = await db.select().from(members).where(eq(members.id, created.body.id));
    expect(after.status).toBe("connecte_autonome"); // point 13 : statut à jour une fois relié
  });

  it("fiche d'adolescent reliée : les parents en restent gestionnaires", async () => {
    const created = await as(f.a1).post("/api/members").send({ familyId: f.family.id, firstName: "Khady", lastName: "Diallo", dateOfBirth: yearsAgo(16), gender: "F", kinship: "enfant" });
    const khady = await createUser("Khady");
    const { token } = await invite(f.a1, f.family, { email: khady.email, role: "dependent", linkedMemberId: created.body.id });
    expect((await accept(khady, token)).status).toBe(200);
    const roles = await rolesOn(created.body);
    expect(roles.map((r) => [r.userId, r.role])).toEqual([[f.a1.id, "gestionnaire"]]);
    const [after] = await db.select().from(members).where(eq(members.id, created.body.id));
    expect(after.status).toBe("adolescent");
  });
});

describe("Point 2 — on ne s'attribue rien soi-même ; seul le titulaire choisit sa fiche", () => {
  it("refuse de s'attribuer un rôle sur un dossier", async () => {
    const grandPere = await fiche(f.family, "Grand-père", "1940-01-01");
    const res = await as(f.a1).post("/api/document-roles").send({ memberId: grandPere.id, userId: f.a1.id, role: "lecteur_invite" });
    expect(res.status).toBe(400);
  });

  it("un parent ne relie pas un adulte qui a déjà sa fiche à une autre ; il relie un compte sans fiche (15 ans minimum) ou un adolescent", async () => {
    const fatou = await createUser("Fatou");
    const fatouM = await addMembership(fatou, f.family, "adult");
    await linkMember(fatouM, await fiche(f.family, "Fatou", "1995-01-01"));
    const autre = await fiche(f.family, "Autre", "1990-01-01");
    let res = await as(f.a1).put("/api/family-memberships").send({ id: fatouM.id, role: "adult", linkedMemberId: autre.id });
    expect(res.status).toBe(403);

    const sansFiche = await createUser("Omar");
    const omarM = await addMembership(sansFiche, f.family, "adult");
    const petit = await fiche(f.family, "Petit", yearsAgo(10));
    res = await as(f.a1).put("/api/family-memberships").send({ id: omarM.id, role: "adult", linkedMemberId: petit.id });
    expect(res.status).toBe(400);
    res = await as(f.a1).put("/api/family-memberships").send({ id: omarM.id, role: "adult", linkedMemberId: autre.id });
    expect(res.status).toBe(200);

    const ado = await createUser("Ado");
    const adoM = await addMembership(ado, f.family, "dependent");
    const ficheAdo = await fiche(f.family, "Ado", yearsAgo(16));
    await linkMember(adoM, ficheAdo);
    const autreAdo = await fiche(f.family, "Ado bis", yearsAgo(16));
    res = await as(f.a1).put("/api/family-memberships").send({ id: adoM.id, role: "dependent", linkedMemberId: autreAdo.id });
    expect(res.status).toBe(200);
    const [old] = await db.select().from(members).where(eq(members.id, ficheAdo.id));
    expect(old.status).toBe("mineur_gere");
  });
});

describe("Point 3 — date de naissance d'une fiche reliée à un compte", () => {
  let fatou, fatouFiche, a2, a2Fiche, omar;
  beforeEach(async () => {
    fatou = await createUser("Fatou");
    fatouFiche = await fiche(f.family, "Fatou", "1995-01-01");
    await linkMember(await addMembership(fatou, f.family, "adult"), fatouFiche);
    a2 = await createUser("Moussa");
    a2Fiche = await fiche(f.family, "Moussa", "1978-01-01", { kinship: "parent" });
    await linkMember(await addMembership(a2, f.family, "parent"), a2Fiche);
    omar = await createUser("Omar");
    await addMembership(omar, f.family, "adult");
  });

  it("un parent (non A1) ne peut pas changer le rôle effectif d'un compte ; A1 le peut", async () => {
    let res = await as(a2).put("/api/members").send(identity(fatouFiche, yearsAgo(16)));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Le changement de date de naissance modifierait les droits de ce compte : demandez à l'administrateur familial");
    res = await as(a2).put("/api/members").send(identity(fatouFiche, "1994-05-05"));
    expect(res.status).toBe(200);
    res = await as(f.a1).put("/api/members").send(identity(fatouFiche, yearsAgo(16)));
    expect(res.status).toBe(200);
  });

  it("un gestionnaire (non parent) ne change pas la date de naissance d'une personne qui a un compte", async () => {
    await grantRole(fatouFiche, omar, "gestionnaire");
    const res = await as(omar).put("/api/members").send(identity(fatouFiche, "1994-05-05"));
    expect(res.status).toBe(403);
    expect((await as(omar).put("/api/members").send({ ...identity(fatouFiche), firstName: "Fatoumata" })).status).toBe(200);
  });

  it("la fiche d'un parent : seulement par ce parent, et il reste majeur", async () => {
    await grantRole(a2Fiche, f.a1, "gestionnaire"); // délégation explicite par A2
    expect((await as(f.a1).put("/api/members").send({ ...identity(a2Fiche), dateOfBirth: "1979-01-01" })).status).toBe(403);
    expect((await as(a2).put("/api/members").send({ ...identity(a2Fiche), dateOfBirth: "1979-01-01" })).status).toBe(200);
    expect((await as(a2).put("/api/members").send({ ...identity(a2Fiche), dateOfBirth: yearsAgo(17) })).status).toBe(400);
  });

  it("sur sa propre fiche, un adulte corrige sa date tant qu'il reste adulte", async () => {
    expect((await as(fatou).put("/api/members").send(identity(fatouFiche, yearsAgo(16)))).status).toBe(400);
    expect((await as(fatou).put("/api/members").send(identity(fatouFiche, "1996-07-07"))).status).toBe(200);
  });
});

describe("Point 5 — aucun rôle de dossier pour un adolescent ; rappels selon le droit réel", () => {
  it("refuse un rôle à un compte adolescent, par l'attribution comme par l'invitation", async () => {
    const ado = await createUser("Ado");
    await linkMember(await addMembership(ado, f.family, "adult"), await fiche(f.family, "Ado", yearsAgo(16)));
    const grandPere = await fiche(f.family, "Grand-père", "1940-01-01");
    const res = await as(f.a1).post("/api/document-roles").send({ memberId: grandPere.id, userId: ado.id, role: "relais" });
    expect(res.status).toBe(400);

    const teenFiche = await fiche(f.family, "Ado2", yearsAgo(16));
    const inv = await invite(f.a1, f.family, { email: "ado2@test.local", role: "dependent", linkedMemberId: teenFiche.id, documentMemberId: grandPere.id, documentRole: "relais" });
    expect(inv.res.status).toBe(400);
  });

  it("un gestionnaire devenu adolescent (ou sans accès) ne reçoit plus les rappels", async () => {
    const ado = await createUser("Ado");
    await linkMember(await addMembership(ado, f.family, "adult"), await fiche(f.family, "Ado", yearsAgo(16)));
    const fatou = await createUser("Fatou");
    await addMembership(fatou, f.family, "adult");
    const grandPere = await fiche(f.family, "Grand-père", "1940-01-01");
    await grantRole(grandPere, ado, "gestionnaire"); // rôle ancien, posé avant les règles actuelles
    await grantRole(grandPere, fatou, "gestionnaire");
    const now = new Date("2026-11-10T09:00:00Z");
    await db.insert(appointments).values({ memberId: grandPere.id, title: "Contrôle", appointmentDate: new Date(now.getTime() + 48 * 3600 * 1000) });
    await runReminderTick({ now, sendMail: async () => "<id>" });
    const to = async (u) => db.select().from(notifications).where(eq(notifications.userId, u.id));
    expect(await to(ado)).toHaveLength(0);
    expect(await to(fatou)).toHaveLength(1);
  });
});

describe("Point 6 — « Ma fiche » (claim)", () => {
  it("contrôle d'âge pour tous ; un parent ne s'approprie pas la fiche d'un enfant", async () => {
    const enfant = await as(f.a1).post("/api/members").send({ familyId: f.family.id, firstName: "Enfant", lastName: "Diallo", dateOfBirth: yearsAgo(16), gender: "M", kinship: "enfant" });
    const a2 = await createUser("Moussa");
    await addMembership(a2, f.family, "parent");
    const a2Enfant = await as(a2).post("/api/members").send({ familyId: f.family.id, firstName: "Ado", lastName: "Diallo", dateOfBirth: yearsAgo(16), gender: "M", kinship: "enfant" });
    let res = await as(a2).post("/api/members/claim").send({ id: a2Enfant.body.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mineur/);

    const ado = await createUser("Ado");
    await addMembership(ado, f.family, "adult");
    const petit = await as(ado).post("/api/members").send({ familyId: f.family.id, firstName: "Petit", lastName: "Diallo", dateOfBirth: yearsAgo(12), gender: "M", kinship: "autre" });
    res = await as(ado).post("/api/members/claim").send({ id: petit.body.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Moins de 15 ans/);

    // A2 n'est pas gestionnaire de la fiche créée par A1 : refusé.
    expect((await as(a2).post("/api/members/claim").send({ id: enfant.body.id })).status).toBe(403);
  });

  it("une fiche gérée et libre devient « ma fiche » ; les autres rôles posés avant tombent", async () => {
    const omar = await createUser("Omar");
    await addMembership(omar, f.family, "adult");
    const created = await as(omar).post("/api/members").send({ familyId: f.family.id, firstName: "Omar", lastName: "Diallo", dateOfBirth: "1990-01-01", gender: "M", kinship: "autre", consent: attestation(omar) });
    const fatou = await createUser("Fatou");
    await addMembership(fatou, f.family, "adult");
    await grantRole(created.body, fatou, "lecteur_invite");
    expect((await as(omar).post("/api/members/claim").send({ id: created.body.id })).status).toBe(200);
    expect(await rolesOn(created.body)).toHaveLength(0);
    expect((await listed(omar, f.family, created.body)).isMine).toBe(true);
  });
});

describe("Points 7, 8, 16, 18 — invitations revérifiées à l'acceptation", () => {
  it("limite de 2 parents revérifiée à l'acceptation", async () => {
    const x = await createUser("X");
    const { token } = await invite(f.a1, f.family, { email: x.email, role: "parent" });
    const y = await createUser("Y");
    const yM = await addMembership(y, f.family, "adult");
    expect((await as(f.a1).put("/api/family-memberships").send({ id: yM.id, role: "parent" })).status).toBe(200);
    const res = await accept(x, token);
    expect(res.status).toBe(409);
  });

  it("le rôle de dossier prévu n'est plus attribuable : invitation refusée", async () => {
    const grandPere = await fiche(f.family, "Grand-père", "1940-01-01");
    await attest(grandPere, f.a1);
    const x = await createUser("X");
    const { res, token } = await invite(f.a1, f.family, { email: x.email, role: "adult", documentMemberId: grandPere.id, documentRole: "relais" });
    expect(res.status).toBe(201);
    expect((await as(f.a1).delete(`/api/members?id=${grandPere.id}`)).status).toBe(200);
    expect((await accept(x, token)).status).toBe(409);
  });

  it("invitation « adolescent » dont la fiche a été supprimée : refusée (409)", async () => {
    const teen = await fiche(f.family, "Ado", yearsAgo(16));
    const x = await createUser("X");
    const { token } = await invite(f.a1, f.family, { email: x.email, role: "dependent", linkedMemberId: teen.id });
    expect((await as(f.a1).delete(`/api/members?id=${teen.id}`)).status).toBe(200);
    expect((await accept(x, token)).status).toBe(409);
  });

  it("courriel d'invitation non envoyé : invitation supprimée, 502", async () => {
    vi.mocked(sendInvitationEmail).mockRejectedValueOnce(new Error("SMTP indisponible"));
    const res = await as(f.a1).post("/api/invitations").send({ familyId: f.family.id, email: "x@test.local", role: "adult" });
    expect(res.status).toBe(502);
    expect(await db.select().from(pendingInvitations)).toHaveLength(0);
  });

  it("un mineur n'est jamais parent : ni par invitation, ni par promotion", async () => {
    const teen = await fiche(f.family, "Ado", yearsAgo(16));
    const inv = await invite(f.a1, f.family, { email: "ado@test.local", role: "parent", linkedMemberId: teen.id });
    expect(inv.res.status).toBe(400);

    const ado = await createUser("Ado");
    const adoM = await addMembership(ado, f.family, "dependent");
    await linkMember(adoM, teen);
    expect((await as(f.a1).put("/api/family-memberships").send({ id: adoM.id, role: "parent" })).status).toBe(400);
  });

  it("l'âge se calcule dans le fuseau de l'application, pas en UTC", () => {
    // 23 h 30 UTC le 12 octobre = 0 h 30 le 13 octobre à Niamey (UTC+1).
    const now = new Date("2026-10-12T23:30:00Z");
    expect(ageOn("2008-10-13", now, "Africa/Niamey")).toBe(18);
    expect(ageOn("2008-10-13", now, "UTC")).toBe(17);
  });
});
