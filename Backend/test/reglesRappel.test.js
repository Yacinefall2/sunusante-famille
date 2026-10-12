import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { appointments, members, notifications, relayTasks } from "../src/db/schema.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { addDays, localDate, zonedTime } from "../src/lib/time.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, grantRole, as } from "./helpers.js";

// UC-08 : règles d'escalade des rappels du Village, réglables par les parents
// (A1, A2) dans des bornes fixes. Sans réglage, le cycle d'origine (vérifié
// aussi par village.test.js, inchangé).

const plusH = (d, h) => new Date(d.getTime() + h * 3600 * 1000);
const tick = (now) => runReminderTick({ now, sendMail: async () => "<id@test>" });
const notifsOf = (user, category) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, user.id), category ? eq(notifications.category, category) : undefined))
    .orderBy(notifications.id);

const NOW = new Date("2026-11-10T09:00:00Z");
let f;
beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Ndiaye");
  const [awa, moussa, fatou, omar] = await Promise.all(["Awa", "Moussa", "Fatou", "Omar"].map((n) => createUser(n)));
  const awaM = await addMembership(awa, family, "parent", { isPrimaryAdmin: true });
  const moussaM = await addMembership(moussa, family, "parent");
  await addMembership(fatou, family, "adult");
  await addMembership(omar, family, "adult");
  await linkMember(awaM, await createMember(family, "Awa"));
  await linkMember(moussaM, await createMember(family, "Moussa"));
  const gp = await createMember(family, "Grand-père");
  await db.update(members).set({ status: "non_connecte" }).where(eq(members.id, gp.id));
  await grantRole(gp, fatou, "gestionnaire");
  await grantRole(gp, omar, "relais");
  f = { family, awa, moussa, fatou, omar, gp };
});

const addAppointment = async (date) =>
  (await db.insert(appointments).values({ memberId: f.gp.id, title: "Contrôle", location: "Kolda", appointmentDate: date, status: "confirmed" }).returning())[0];
const settings = (user, body) => as(user).put("/api/reminder-settings").send({ familyId: f.family.id, ...body });
const VALID = { relayFirstDays: 5, followUpDaysBefore: 2, escalationDelayHours: 6, attendancePrompt: "next_morning" };
const villageJournal = async () =>
  (await as(f.awa).get(`/api/activity?familyId=${f.family.id}&category=village`)).body.entries.map((e) => e.text);

describe("Réglages : lecture, bornes, droits, journal", () => {
  it("sans réglage : les valeurs par défaut du cycle d'origine", async () => {
    const res = await as(f.awa).get(`/api/reminder-settings?familyId=${f.family.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      relayFirstDays: 3,
      followUpDaysBefore: 1,
      escalationDelayHours: 3,
      attendancePrompt: "same_evening",
      isDefault: true,
    });
  });

  it("réservé aux parents (A1 et A2)", async () => {
    expect((await as(f.fatou).get(`/api/reminder-settings?familyId=${f.family.id}`)).status).toBe(403);
    expect((await settings(f.fatou, VALID)).status).toBe(403);
    expect((await as(f.fatou).delete(`/api/reminder-settings?familyId=${f.family.id}`)).status).toBe(403);
    expect((await settings(f.moussa, VALID)).status).toBe(200);
  });

  it("bornes refusées (400)", async () => {
    for (const bad of [
      { relayFirstDays: 8 },
      { relayFirstDays: 1 },
      { followUpDaysBefore: 3 },
      { escalationDelayHours: 0 },
      { escalationDelayHours: 13 },
      { escalationDelayHours: 2.5 },
      { relayFirstDays: "5" },
      { attendancePrompt: "midi" },
      { relayFirstDays: 2, followUpDaysBefore: 2 },
    ]) {
      expect((await settings(f.awa, { ...VALID, ...bad })).status).toBe(400);
    }
    expect((await as(f.awa).get(`/api/reminder-settings?familyId=${f.family.id}`)).body.isDefault).toBe(true);
  });

  it("modification puis rétablissement : journalisés en clair", async () => {
    const res = await settings(f.awa, VALID);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ...VALID, isDefault: false });
    const reset = await as(f.awa).delete(`/api/reminder-settings?familyId=${f.family.id}`);
    expect(reset.body).toMatchObject({ relayFirstDays: 3, isDefault: true });
    expect(await villageJournal()).toEqual([
      "Awa a rétabli les règles de rappel du Village par défaut : premier « à relayer » 3 jours avant, relance la veille, escalade vers les relais 3 h après sans « Prévenu », présence demandée le soir même",
      "Awa a modifié les règles de rappel du Village : premier « à relayer » 5 jours avant, relance 2 jours avant, escalade vers les relais 6 h après sans « Prévenu », présence demandée le lendemain matin",
    ]);
  });
});

describe("Effet sur le cycle du Village (worker, now simulé)", () => {
  it("premier « à relayer » : 3 jours avant par défaut, 5 jours avant une fois réglé", async () => {
    await addAppointment(plusH(NOW, 110)); // 4 jours et demi
    await tick(NOW);
    expect(await notifsOf(f.fatou)).toHaveLength(0);

    await settings(f.awa, { ...VALID, relayFirstDays: 5 });
    await tick(plusH(NOW, 0.1));
    const list = await notifsOf(f.fatou);
    expect(list).toHaveLength(1);
    expect(list[0].category).toBe("relay_to_relay");
  });

  it("relance 2 jours avant, escalade 6 h après la relance", async () => {
    await settings(f.awa, { ...VALID, relayFirstDays: 3, followUpDaysBefore: 2, escalationDelayHours: 6 });
    const rdv = plusH(NOW, 70);
    await addAppointment(rdv);
    await tick(NOW);
    await tick(plusH(rdv, -47)); // 47 h avant : relance (2 jours avant)
    expect((await notifsOf(f.fatou)).map((n) => n.title.split(" :")[0])).toEqual(["À relayer", "Relance"]);
    expect((await notifsOf(f.fatou))[1].body).toContain("Sans « Prévenu » d'ici 6 h");

    await tick(plusH(rdv, -44)); // relance + 3 h : pas encore (6 h réglées)
    expect(await notifsOf(f.omar)).toHaveLength(0);
    await tick(plusH(rdv, -41)); // relance + 6 h : escalade
    expect((await notifsOf(f.omar, "relay_escalation")).length).toBe(1);
  });

  it("par défaut, l'escalade a lieu 3 h après la relance (comportement d'origine)", async () => {
    const rdv = plusH(NOW, 70);
    await addAppointment(rdv);
    await tick(NOW);
    await tick(plusH(rdv, -23));
    await tick(plusH(rdv, -20));
    expect((await notifsOf(f.omar, "relay_escalation")).length).toBe(1);
  });

  it("présence : 12 h après par défaut ; le lendemain à 8 h une fois réglé", async () => {
    const rdvDay = "2026-11-13";
    const rdv = zonedTime(rdvDay, "07:00");
    await addAppointment(rdv);
    await settings(f.awa, { ...VALID, attendancePrompt: "next_morning" });
    await tick(plusH(rdv, -70));
    await tick(plusH(rdv, 13)); // 13 h après : le défaut aurait déjà demandé
    expect(await notifsOf(f.fatou, "relay_update")).toHaveLength(0);
    const nextMorning = zonedTime(addDays(localDate(rdv), 1), "08:00");
    await tick(plusH(nextMorning, -0.1));
    expect(await notifsOf(f.fatou, "relay_update")).toHaveLength(0);
    await tick(nextMorning);
    const [prompt] = await notifsOf(f.fatou, "relay_update");
    expect(prompt.title).toBe("Grand-père Test s'est-il rendu à son rendez-vous ?");
    const [task] = await db.select().from(relayTasks);
    expect(task.attendancePromptAt).not.toBeNull();
  });

  it("présence par défaut : 12 h après le rendez-vous", async () => {
    const rdv = zonedTime("2026-11-13", "07:00");
    await addAppointment(rdv);
    await tick(plusH(rdv, -70));
    await tick(plusH(rdv, 11.9));
    expect(await notifsOf(f.fatou, "relay_update")).toHaveLength(0);
    await tick(plusH(rdv, 12));
    expect(await notifsOf(f.fatou, "relay_update")).toHaveLength(1);
  });

  it("les réglages d'une famille ne touchent pas les autres familles", async () => {
    const other = await createFamily("Autre");
    const gestionnaire = await createUser("Gestionnaire");
    await addMembership(gestionnaire, other, "parent", { isPrimaryAdmin: true });
    const papy = await createMember(other, "Papy");
    await db.update(members).set({ status: "non_connecte" }).where(eq(members.id, papy.id));
    await grantRole(papy, gestionnaire, "gestionnaire");
    await db.insert(appointments).values({ memberId: papy.id, title: "Contrôle", appointmentDate: plusH(NOW, 110) });
    await addAppointment(plusH(NOW, 110));
    await settings(f.awa, { ...VALID, relayFirstDays: 5 });
    await tick(NOW);
    expect(await notifsOf(f.fatou)).toHaveLength(1);
    expect(await notifsOf(gestionnaire)).toHaveLength(0);
  });
});
