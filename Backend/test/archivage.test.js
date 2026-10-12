import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { appointments, documentRoles, familyMemberships, members, notifications, users } from "../src/db/schema.js";
import { sendInvitationEmail } from "../src/lib/mailer.js";
import { archiveFicheOfLeavingAccount } from "../src/lib/archive.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { resetDatabase, createUser, createFamily, addMembership, linkMember, grantRole, seedMedicalData, as } from "./helpers.js";

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

async function fiche(family, firstName, dateOfBirth, extra = {}) {
  const [m] = await db
    .insert(members)
    .values({ familyId: family.id, firstName, lastName: "Sow", dateOfBirth, gender: "F", kinship: "autre", allergies: "Arachides", ...extra })
    .returning();
  return m;
}
const reload = async (m) => (await db.select().from(members).where(eq(members.id, m.id)))[0];
const listed = async (user, family, m) => (await as(user).get(`/api/members?familyId=${family.id}`)).body.find((x) => x.id === m.id);

// Foyer : Awa (A1), Moussa (A2), Fatou (adulte, titulaire de sa fiche, qui
// délègue la lecture à Omar), Khady (adolescente, titulaire de sa fiche).
let f;
beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Sow");
  const [awa, moussa, fatou, omar, khady] = await Promise.all(["Awa", "Moussa", "Fatou", "Omar", "Khady"].map((n) => createUser(n)));
  const awaM = await addMembership(awa, family, "parent", { isPrimaryAdmin: true });
  await linkMember(awaM, await fiche(family, "Awa", "1980-01-01", { kinship: "parent" }));
  await addMembership(moussa, family, "parent");
  const fatouM = await addMembership(fatou, family, "adult");
  const fatouFiche = await fiche(family, "Fatou", "1995-01-01");
  await linkMember(fatouM, fatouFiche);
  await seedMedicalData(fatouFiche);
  await addMembership(omar, family, "adult");
  await grantRole(fatouFiche, omar, "lecteur_invite");
  const khadyM = await addMembership(khady, family, "dependent");
  const khadyFiche = await fiche(family, "Khady", yearsAgo(16));
  await linkMember(khadyM, khadyFiche);
  f = { family, awa, moussa, fatou, omar, khady, fatouM, fatouFiche, khadyM, khadyFiche };
});

const removeFatou = () => as(f.awa).delete(`/api/family-memberships?id=${f.fatouM.id}`);

describe("Un adulte quitte la famille : sa fiche est archivée (gelée)", () => {
  it("plus aucun accès pour personne, parents compris ; seuls prénom et nom restent visibles", async () => {
    await db.insert(notifications).values({ userId: f.omar.id, familyId: f.family.id, memberId: f.fatouFiche.id, category: "appointment_reminder", dedupeKey: "x1", title: "RDV secret" });
    expect((await removeFatou()).status).toBe(200);

    const archived = await reload(f.fatouFiche);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.archivedUserId).toBe(f.fatou.id);
    expect(await db.select().from(documentRoles).where(eq(documentRoles.memberId, f.fatouFiche.id))).toHaveLength(0);
    expect(await db.select().from(notifications).where(eq(notifications.memberId, f.fatouFiche.id))).toHaveLength(0);

    for (const user of [f.awa, f.moussa, f.omar]) {
      const seen = await listed(user, f.family, f.fatouFiche);
      expect(Object.keys(seen).sort()).toEqual(
        ["access", "account", "archived", "familyId", "firstName", "hasAccount", "id", "isMine", "lastName", "myDocumentRole", "relayPending"].sort()
      );
      expect(seen).toMatchObject({ archived: true, firstName: "Fatou", lastName: "Sow", access: null });
      expect((await as(user).get(`/api/treatments?memberId=${f.fatouFiche.id}`)).status).toBe(403);
      const appts = (await as(user).get(`/api/appointments?familyId=${f.family.id}`)).body;
      expect(appts.some((a) => a.memberId === f.fatouFiche.id)).toBe(false);
    }
    expect((await as(f.awa).put("/api/members").send({ id: f.fatouFiche.id, firstName: "X", lastName: "Y", dateOfBirth: "1995-01-01", gender: "F", kinship: "autre" })).status).toBe(403);
    const dash = (await as(f.awa).get(`/api/dashboard/family?familyId=${f.family.id}`)).body;
    expect(dash.members.some((m) => m.id === f.fatouFiche.id)).toBe(false);
  });

  it("ne peut être reliée à aucun autre compte (invitation, liaison par un parent, « Ma fiche »)", async () => {
    await removeFatou();
    const inv = await as(f.awa).post("/api/invitations").send({ familyId: f.family.id, email: "autre@test.local", role: "adult", linkedMemberId: f.fatouFiche.id });
    expect(inv.status).toBe(409);

    const nouveau = await createUser("Nouveau");
    const nouveauM = await addMembership(nouveau, f.family, "adult");
    expect((await as(f.awa).put("/api/family-memberships").send({ id: nouveauM.id, role: "adult", linkedMemberId: f.fatouFiche.id })).status).toBe(409);

    await grantRole(f.fatouFiche, nouveau, "gestionnaire"); // même avec un rôle (posé hors API)
    expect((await as(nouveau).post("/api/members/claim").send({ id: f.fatouFiche.id })).status).toBe(409);
  });

  it("seul l'administrateur familial A1 peut la supprimer définitivement", async () => {
    await removeFatou();
    expect((await as(f.moussa).delete(`/api/members?id=${f.fatouFiche.id}`)).status).toBe(403);
    expect((await as(f.awa).delete(`/api/members?id=${f.fatouFiche.id}`)).status).toBe(200);
    expect(await reload(f.fatouFiche)).toBeUndefined();
  });

  it("l'ancienne titulaire réinvitée la retrouve automatiquement, avec son dossier", async () => {
    await removeFatou();
    vi.mocked(sendInvitationEmail).mockClear();
    expect((await as(f.awa).post("/api/invitations").send({ familyId: f.family.id, email: f.fatou.email, role: "adult" })).status).toBe(201);
    const token = vi.mocked(sendInvitationEmail).mock.lastCall[0].token;
    const res = await as(f.fatou).post(`/api/invitations/${token}/accept`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ restored: true, linkedMemberId: f.fatouFiche.id });

    const restored = await reload(f.fatouFiche);
    expect(restored.archivedAt).toBeNull();
    const seen = await listed(f.fatou, f.family, f.fatouFiche);
    expect(seen).toMatchObject({ isMine: true, access: "full", archived: false, allergies: "Arachides" });
    expect((await as(f.fatou).get(`/api/treatments?memberId=${f.fatouFiche.id}`)).body).toHaveLength(1);
    // Les rôles accordés avant son départ ne reviennent pas.
    expect((await listed(f.omar, f.family, f.fatouFiche)).access).toBeNull();
  });

  it("aucun rappel pour une fiche archivée", async () => {
    await removeFatou();
    const now = new Date("2026-11-10T09:00:00Z");
    await db.insert(appointments).values({ memberId: f.fatouFiche.id, title: "Contrôle", appointmentDate: new Date(now.getTime() + 30 * 3600 * 1000) });
    await runReminderTick({ now, sendMail: async () => "<id>" });
    expect(await db.select().from(notifications).where(eq(notifications.memberId, f.fatouFiche.id))).toHaveLength(0);
  });

  it("compte supprimé (routes/account.js) : la fonction d'archivage gèle aussi la fiche", async () => {
    const [membership] = await db.select().from(familyMemberships).where(eq(familyMemberships.id, f.fatouM.id));
    expect(await archiveFicheOfLeavingAccount(membership)).toEqual({ memberId: f.fatouFiche.id, archived: true });
    await db.delete(users).where(eq(users.id, f.fatou.id));
    const archived = await reload(f.fatouFiche);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.archivedUserId).toBeNull();
    expect((await listed(f.awa, f.family, f.fatouFiche)).archived).toBe(true);
  });
});

describe("Un adolescent quitte la famille : sa fiche redevient gérée par les parents", () => {
  it("pas d'archivage ; les parents gardent l'accès", async () => {
    expect((await as(f.awa).delete(`/api/family-memberships?id=${f.khadyM.id}`)).status).toBe(200);
    const after = await reload(f.khadyFiche);
    expect(after.archivedAt).toBeNull();
    expect(after.status).toBe("mineur_gere");
    expect((await listed(f.awa, f.family, f.khadyFiche)).access).toBe("full");
  });
});

describe("Notifications d'un compte retiré (point 9)", () => {
  it("supprimées au retrait ; la cloche n'affiche que les familles dont on est membre", async () => {
    await db.insert(notifications).values({ userId: f.fatou.id, familyId: f.family.id, category: "vaccine_reminder", dedupeKey: "n1", title: "Rappel" });
    await removeFatou();
    expect(await db.select().from(notifications).where(eq(notifications.userId, f.fatou.id))).toHaveLength(0);

    const autre = await createFamily("Autre");
    await db.insert(notifications).values({ userId: f.omar.id, familyId: autre.id, category: "vaccine_reminder", dedupeKey: "n2", title: "Ailleurs" });
    await db.insert(notifications).values({ userId: f.omar.id, familyId: f.family.id, category: "vaccine_reminder", dedupeKey: "n3", title: "Ici" });
    const items = (await as(f.omar).get("/api/notifications")).body.items;
    expect(items.map((n) => n.title)).toEqual(["Ici"]);
  });

  it("révocation d'un rôle : ses notifications sur ce dossier disparaissent", async () => {
    await db.insert(notifications).values({ userId: f.omar.id, familyId: f.family.id, memberId: f.fatouFiche.id, category: "appointment_reminder", dedupeKey: "n4", title: "RDV de Fatou" });
    const [role] = await db.select().from(documentRoles).where(eq(documentRoles.userId, f.omar.id));
    expect((await as(f.fatou).delete(`/api/document-roles?id=${role.id}`)).status).toBe(200);
    expect(await db.select().from(notifications).where(eq(notifications.userId, f.omar.id))).toHaveLength(0);
  });
});
