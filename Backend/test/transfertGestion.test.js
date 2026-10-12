import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { documentRoles, members, notifications, roleTransfers } from "../src/db/schema.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, grantRole, as } from "./helpers.js";

// UC-39 : transférer la gestion d'un dossier à un autre membre — le membre
// destinataire accepte (proposition, acceptation, refus, annulation,
// expiration par le worker, droits).

const DAY = 24 * 3600 * 1000;
const tick = (now) => runReminderTick({ now, sendMail: async () => "<id@test>" });
const notifsOf = (user) => db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(notifications.id);
const rolesOn = (fiche) => db.select().from(documentRoles).where(eq(documentRoles.memberId, fiche.id));
const journal = async (user) => (await as(user).get(`/api/activity?familyId=${f.family.id}&category=roles`)).body.entries.map((e) => e.text);

// Foyer Sarr : Awa (A1), Moussa (A2), Fatou et Omar (adultes), Khady (16 ans,
// compte adolescent). Fatou gère la fiche de Papy (sans compte).
let f;
beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Sarr");
  const [awa, moussa, fatou, omar, khady] = await Promise.all(["Awa", "Moussa", "Fatou", "Omar", "Khady"].map((n) => createUser(n)));
  const awaM = await addMembership(awa, family, "parent", { isPrimaryAdmin: true });
  const moussaM = await addMembership(moussa, family, "parent");
  const fatouM = await addMembership(fatou, family, "adult");
  const omarM = await addMembership(omar, family, "adult");
  const khadyM = await addMembership(khady, family, "adult");
  for (const [m, name] of [[awaM, "Awa"], [moussaM, "Moussa"], [fatouM, "Fatou"], [omarM, "Omar"]]) {
    await linkMember(m, await createMember(family, name));
  }
  const khadyFiche = await createMember(family, "Khady");
  const sixteen = new Date();
  sixteen.setUTCFullYear(sixteen.getUTCFullYear() - 16);
  await db.update(members).set({ dateOfBirth: sixteen.toISOString().slice(0, 10) }).where(eq(members.id, khadyFiche.id));
  await linkMember(khadyM, khadyFiche);
  const papy = await createMember(family, "Papy");
  await grantRole(papy, fatou, "gestionnaire");
  f = { family, awa, moussa, fatou, omar, khady, papy, omarFiche: omarM.linkedMemberId };
});

const propose = (from, to, fiche = f.papy) => as(from).post("/api/role-transfers").send({ memberId: fiche.id, toUserId: to.id });

describe("Proposition (UC-39)", () => {
  it("le gestionnaire propose : le destinataire est prévenu, la proposition apparaît des deux côtés", async () => {
    const res = await propose(f.fatou, f.omar);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ memberId: f.papy.id, fromName: "Fatou", toName: "Omar", status: "pending" });
    expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * DAY);

    const [n] = await notifsOf(f.omar);
    expect(n).toMatchObject({ category: "role_transfer", link: "/dashboard" });
    expect(n.title).toBe("Fatou vous propose de reprendre la gestion du dossier de Papy Test");

    const received = (await as(f.omar).get(`/api/role-transfers?familyId=${f.family.id}`)).body;
    expect(received.received.map((t) => t.id)).toEqual([res.body.id]);
    expect(received.sent).toEqual([]);
    const sent = (await as(f.fatou).get(`/api/role-transfers?familyId=${f.family.id}&memberId=${f.papy.id}`)).body;
    expect(sent.sent.map((t) => t.id)).toEqual([res.body.id]);
    expect(sent.member).toMatchObject({ canTransfer: true, pending: { id: res.body.id } });

    expect(await journal(f.awa)).toContain("Fatou a proposé à Omar de reprendre la gestion du dossier de Papy Test");
  });

  it("une seule proposition en attente par fiche", async () => {
    expect((await propose(f.fatou, f.omar)).status).toBe(201);
    const second = await propose(f.awa, f.moussa);
    expect(second.status).toBe(409);
  });

  it("droits : adolescent, non-gestionnaire, titulaire adulte, déjà gestionnaire, soi-même refusés", async () => {
    // Destinataire adolescent
    expect((await propose(f.fatou, f.khady)).status).toBe(400);
    // Proposant ni gestionnaire ni parent
    expect((await propose(f.omar, f.moussa)).status).toBe(403);
    // Proposant adolescent
    expect((await propose(f.khady, f.omar)).status).toBe(403);
    // Fiche tenue par son titulaire adulte : pas de transfert
    const omarFiche = { id: f.omarFiche };
    expect((await propose(f.awa, f.fatou, omarFiche)).status).toBe(400);
    // Destinataire déjà gestionnaire
    await grantRole(f.papy, f.omar, "gestionnaire");
    expect((await propose(f.fatou, f.omar)).status).toBe(400);
    // Soi-même
    expect((await propose(f.fatou, f.fatou)).status).toBe(400);
    // Compte d'une autre famille
    const outsider = await createUser("Étranger");
    expect((await propose(f.fatou, outsider)).status).toBe(400);
    expect(await db.select().from(roleTransfers)).toHaveLength(0);
  });
});

describe("Réponse du destinataire", () => {
  it("acceptation : le destinataire devient gestionnaire, le proposant perd son rôle et en est prévenu", async () => {
    const { body } = await propose(f.fatou, f.omar);
    // Seul le destinataire répond.
    expect((await as(f.fatou).post(`/api/role-transfers/${body.id}/accept`)).status).toBe(403);
    const res = await as(f.omar).post(`/api/role-transfers/${body.id}/accept`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "accepted", proposerWasManager: true });

    const roles = await rolesOn(f.papy);
    expect(roles.map((r) => [r.userId, r.role])).toEqual([[f.omar.id, "gestionnaire"]]);
    // Fatou n'a plus accès au dossier ; Omar si.
    expect((await as(f.fatou).get(`/api/treatments?memberId=${f.papy.id}`)).status).toBe(403);
    expect((await as(f.omar).get(`/api/treatments?memberId=${f.papy.id}`)).status).toBe(200);

    const fatouNotifs = await notifsOf(f.fatou);
    expect(fatouNotifs.map((n) => n.title)).toEqual(["Omar a accepté de reprendre la gestion du dossier de Papy Test"]);
    // La proposition est lue chez le destinataire.
    expect((await notifsOf(f.omar))[0].readAt).not.toBeNull();
    expect(await journal(f.awa)).toContain(
      "Omar a accepté de reprendre la gestion du dossier de Papy Test, proposée par Fatou — Fatou n'en est plus gestionnaire"
    );
    // Plus rien à répondre.
    expect((await as(f.omar).post(`/api/role-transfers/${body.id}/decline`)).status).toBe(409);
  });

  it("un parent qui propose sans être gestionnaire garde son accès de parent", async () => {
    const { body } = await propose(f.awa, f.omar);
    expect((await as(f.omar).post(`/api/role-transfers/${body.id}/accept`)).body.proposerWasManager).toBe(false);
    const roles = await rolesOn(f.papy);
    expect(roles.map((r) => r.userId).sort()).toEqual([f.fatou.id, f.omar.id].sort());
    expect((await as(f.awa).get(`/api/treatments?memberId=${f.papy.id}`)).status).toBe(200);
  });

  it("refus : rien ne change, le proposant en est prévenu", async () => {
    const { body } = await propose(f.fatou, f.omar);
    const res = await as(f.omar).post(`/api/role-transfers/${body.id}/decline`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("declined");
    expect((await rolesOn(f.papy)).map((r) => r.userId)).toEqual([f.fatou.id]);
    expect((await notifsOf(f.fatou))[0].title).toBe("Omar a refusé de reprendre la gestion du dossier de Papy Test");
    expect(await journal(f.awa)).toContain("Omar a refusé de reprendre la gestion du dossier de Papy Test, proposée par Fatou");
    // Une nouvelle proposition est possible.
    expect((await propose(f.fatou, f.moussa)).status).toBe(201);
  });

  it("annulation : réservée au proposant", async () => {
    const { body } = await propose(f.fatou, f.omar);
    expect((await as(f.omar).post(`/api/role-transfers/${body.id}/cancel`)).status).toBe(403);
    const res = await as(f.fatou).post(`/api/role-transfers/${body.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect((await as(f.omar).post(`/api/role-transfers/${body.id}/accept`)).status).toBe(409);
    expect((await rolesOn(f.papy)).map((r) => r.userId)).toEqual([f.fatou.id]);
    expect(await journal(f.awa)).toContain("Fatou a annulé sa proposition de transfert de la gestion du dossier de Papy Test à Omar");
    expect((await as(f.omar).get(`/api/role-transfers?familyId=${f.family.id}`)).body.received).toEqual([]);
  });
});

describe("Expiration (worker)", () => {
  it("sans réponse au bout de 7 jours : expirée, le proposant est prévenu, plus d'acceptation possible", async () => {
    const { body } = await propose(f.fatou, f.omar);
    await tick(new Date(Date.now() + 6 * DAY));
    expect((await db.select().from(roleTransfers))[0].status).toBe("pending");

    await tick(new Date(Date.now() + 7 * DAY + 60_000));
    const [t] = await db.select().from(roleTransfers);
    expect(t.status).toBe("expired");
    const titles = (await notifsOf(f.fatou)).map((n) => n.title);
    expect(titles).toEqual(["Votre proposition de transfert de la gestion du dossier de Papy Test a expiré"]);
    // Un second passage ne prévient pas deux fois.
    await tick(new Date(Date.now() + 8 * DAY));
    expect(await notifsOf(f.fatou)).toHaveLength(1);

    expect((await as(f.omar).post(`/api/role-transfers/${body.id}/accept`)).status).toBe(409);
    expect(
      await db
        .select()
        .from(documentRoles)
        .where(and(eq(documentRoles.memberId, f.papy.id), eq(documentRoles.userId, f.omar.id)))
    ).toHaveLength(0);
    expect(await journal(f.awa)).toContain(
      "La proposition de transfert de la gestion du dossier de Papy Test à Omar a expiré sans réponse (proposée par Fatou)"
    );
  });

  it("une proposition échue mais pas encore traitée par le worker est refusée (410)", async () => {
    const { body } = await propose(f.fatou, f.omar);
    await db.update(roleTransfers).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(roleTransfers.id, body.id));
    expect((await as(f.omar).post(`/api/role-transfers/${body.id}/accept`)).status).toBe(410);
  });
});

describe("Tableau de bord des parents", () => {
  it("une proposition reçue par un parent apparaît dans « À traiter »", async () => {
    await propose(f.fatou, f.moussa);
    const res = await as(f.moussa).get(`/api/dashboard/family?familyId=${f.family.id}`);
    expect(res.status).toBe(200);
    const item = res.body.todo.find((t) => t.type === "role_transfer");
    expect(item).toMatchObject({ severity: "warn", title: "Fatou vous propose de reprendre la gestion du dossier de Papy Test" });
  });
});
