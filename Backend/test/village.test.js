import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { appointments, members, notifications, relayEvents, relayTasks } from "../src/db/schema.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, grantRole, as } from "./helpers.js";

const at = (iso) => new Date(iso);
const plusH = (d, h) => new Date(d.getTime() + h * 3600 * 1000);
const tick = (now) => runReminderTick({ now, sendMail: async () => "<id@test>" });
const notifsOf = (user) => db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(notifications.id);

// Foyer : Awa (A1), Fatou (gestionnaire du grand-père), Moussa et Omar
// (relais du grand-père), grand-père « non connecté » à Kolda.
let f;
const NOW = at("2026-11-10T09:00:00Z");
const RDV = plusH(NOW, 70); // jeudi 13 novembre 07:00

beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Ndiaye");
  const [awa, fatou, moussa, omar] = await Promise.all(["Awa", "Fatou", "Moussa", "Omar"].map((n) => createUser(n)));
  const awaM = await addMembership(awa, family, "parent", { isPrimaryAdmin: true });
  for (const u of [fatou, moussa, omar]) await addMembership(u, family, "adult");
  await linkMember(awaM, await createMember(family, "Awa"));
  const gp = await createMember(family, "Grand-père");
  await db.update(members).set({ status: "non_connecte", phone: "+221 77 000 00 00" }).where(eq(members.id, gp.id));
  await grantRole(gp, fatou, "gestionnaire");
  await grantRole(gp, moussa, "relais");
  await grantRole(gp, omar, "relais");
  const [appt] = await db
    .insert(appointments)
    .values({ memberId: gp.id, title: "Suivi cardiologie", doctorName: "Dr Mbaye", location: "Hôpital régional de Kolda", appointmentDate: RDV, status: "confirmed" })
    .returning();
  f = { family, awa, fatou, moussa, omar, gp, appt };
});

describe("Cycle du rappel relayé (§4.2)", () => {
  it("J-3 : « à relayer » au gestionnaire seulement, à la place du rappel classique", async () => {
    await tick(NOW);
    const list = await notifsOf(f.fatou);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ category: "relay_to_relay", link: "/village" });
    expect(list[0].title).toBe("À relayer : prévenir Grand-père Test de son rendez-vous");
    expect(list[0].body).toContain("Lieu : Hôpital régional de Kolda");
    for (const u of [f.awa, f.moussa, f.omar]) expect(await notifsOf(u)).toHaveLength(0);
    const all = await db.select().from(notifications);
    expect(all.some((n) => n.category === "appointment_reminder")).toBe(false);
  });

  it("J-1 : relance au gestionnaire, puis escalade vers tous les relais 3 h après — date, heure et lieu seulement", async () => {
    await tick(NOW);
    await tick(plusH(NOW, 47)); // 23 h avant : relance
    expect((await notifsOf(f.fatou)).map((n) => n.title.split(" :")[0])).toEqual(["À relayer", "Relance"]);
    expect(await notifsOf(f.moussa)).toHaveLength(0);

    await tick(plusH(NOW, 49)); // relance + 2 h : pas encore
    expect(await notifsOf(f.moussa)).toHaveLength(0);
    await tick(plusH(NOW, 50)); // relance + 3 h : escalade
    for (const relay of [f.moussa, f.omar]) {
      const [n] = await notifsOf(relay);
      expect(n).toMatchObject({ category: "relay_escalation", title: "Un rappel à relayer" });
      expect(n.body).toContain("Hôpital régional de Kolda");
      expect(n.body).not.toContain("cardiologie");
      expect(n.body).not.toContain("Mbaye");
    }
  });

  it("le premier relais qui confirme clôt pour tous ; le gestionnaire en est informé", async () => {
    await tick(NOW);
    await tick(plusH(NOW, 47));
    await tick(plusH(NOW, 50));
    const [task] = await db.select().from(relayTasks);

    const first = await as(f.omar).post(`/api/village/tasks/${task.id}/notified`);
    expect(first.status).toBe(200);
    const second = await as(f.moussa).post(`/api/village/tasks/${task.id}/notified`);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("Déjà prévenu par Omar");

    expect((await notifsOf(f.moussa)).every((n) => n.readAt)).toBe(true);
    const update = (await notifsOf(f.fatou)).find((n) => n.category === "relay_update");
    expect(update.title).toBe("Omar a prévenu Grand-père Test");
  });

  it("« Prévenu » par le gestionnaire dès J-3 : ni relance ni escalade", async () => {
    await tick(NOW);
    const [task] = await db.select().from(relayTasks);
    expect((await as(f.fatou).post(`/api/village/tasks/${task.id}/notified`)).status).toBe(200);
    await tick(plusH(NOW, 47));
    await tick(plusH(NOW, 51));
    expect(await notifsOf(f.fatou)).toHaveLength(1);
    expect(await notifsOf(f.moussa)).toHaveLength(0);
  });

  it("« Pas joignable » : alerte le gestionnaire et A1, le rappel reste ouvert", async () => {
    await tick(NOW);
    await tick(plusH(NOW, 47));
    await tick(plusH(NOW, 50));
    const [task] = await db.select().from(relayTasks);
    expect((await as(f.moussa).post(`/api/village/tasks/${task.id}/unreachable`)).status).toBe(200);
    for (const u of [f.fatou, f.awa]) {
      const alert = (await notifsOf(u)).find((n) => n.category === "relay_alert");
      expect(alert.title).toBe("Moussa n'a pas pu joindre Grand-père Test");
    }
    expect((await as(f.omar).post(`/api/village/tasks/${task.id}/notified`)).status).toBe(200);
    const events = await db.select().from(relayEvents).where(eq(relayEvents.taskId, task.id)).orderBy(relayEvents.id);
    expect(events.map((e) => e.type)).toEqual(["to_relay", "follow_up", "escalated", "unreachable", "notified"]);
  });

  it("J+1 : demande de présence au gestionnaire, réponse tracée dans l'historique", async () => {
    // La présence ne se renseigne que pour un rendez-vous réellement passé :
    // rendez-vous placé 14 h avant l'heure actuelle réelle.
    const past = plusH(new Date(), -14);
    await db.update(appointments).set({ appointmentDate: past }).where(eq(appointments.id, f.appt.id));
    await tick(plusH(past, -70));
    await tick(plusH(past, 13));
    const prompt = (await notifsOf(f.fatou)).find((n) => n.category === "relay_update");
    expect(prompt.title).toBe("Grand-père Test s'est-il rendu à son rendez-vous ?");
    const res = await as(f.fatou).put("/api/appointments/attendance").send({ id: f.appt.id, attendance: "attended" });
    expect(res.status).toBe(200);
    const [task] = await db.select().from(relayTasks);
    const events = await db.select().from(relayEvents).where(eq(relayEvents.taskId, task.id));
    expect(events.map((e) => e.type)).toContain("attended");
  });
});

describe("Robustesse", () => {
  it("une date enregistrée à la microseconde ne crée pas de seconde tâche", async () => {
    await db.execute(sql`update appointments set appointment_date = ${RDV.toISOString()}::timestamp + interval '123 microseconds' where id = ${f.appt.id}`);
    await tick(NOW);
    await tick(plusH(NOW, 0.1));
    await tick(plusH(NOW, 47));
    expect(await db.select().from(relayTasks)).toHaveLength(1);
    expect((await notifsOf(f.fatou)).map((n) => n.title.split(" :")[0])).toEqual(["À relayer", "Relance"]);
  });
});

describe("Droits et cloisonnement", () => {
  it("un relais ne peut pas agir avant l'escalade ; un membre sans rôle jamais", async () => {
    await tick(NOW);
    const [task] = await db.select().from(relayTasks);
    expect((await as(f.moussa).post(`/api/village/tasks/${task.id}/notified`)).status).toBe(403);
    const outsider = await createUser("Externe");
    await addMembership(outsider, f.family, "adult");
    expect((await as(outsider).post(`/api/village/tasks/${task.id}/notified`)).status).toBe(403);
  });

  it("onglet Village : le gestionnaire voit tout, le relais seulement date, heure, lieu", async () => {
    await tick(NOW);
    let relayView = (await as(f.moussa).get(`/api/village?familyId=${f.family.id}`)).body;
    expect(relayView[0]).toMatchObject({ role: "relay", tasks: [] });

    await tick(plusH(NOW, 47));
    await tick(plusH(NOW, 50));
    const managerView = (await as(f.fatou).get(`/api/village?familyId=${f.family.id}`)).body;
    expect(managerView[0].member.phone).toBe("+221 77 000 00 00");
    expect(managerView[0].tasks[0]).toMatchObject({ title: "Suivi cardiologie", doctorName: "Dr Mbaye", status: "to_relay", escalated: true });
    expect(managerView[0].tasks[0].events.map((e) => e.type)).toEqual(["to_relay", "follow_up", "escalated"]);

    relayView = (await as(f.moussa).get(`/api/village?familyId=${f.family.id}`)).body;
    const task = relayView[0].tasks[0];
    expect(task).toMatchObject({ location: "Hôpital régional de Kolda", status: "to_relay" });
    for (const hidden of ["title", "doctorName", "events", "attendance"]) expect(task).not.toHaveProperty(hidden);
    expect(relayView[0].member).not.toHaveProperty("phone");
  });

  it("badge « À relayer » : gestionnaire dès J-3, relais après l'escalade", async () => {
    await tick(NOW);
    const badge = async (u) => (await as(u).get(`/api/members?familyId=${f.family.id}`)).body.find((m) => m.id === f.gp.id).relayPending;
    expect(await badge(f.fatou)).toBe(true);
    expect(await badge(f.moussa)).toBe(false);
    await tick(plusH(NOW, 47));
    await tick(plusH(NOW, 50));
    expect(await badge(f.moussa)).toBe(true);
  });

  it("rien pour un rendez-vous annulé ; sans gestionnaire, les administrateurs sont prévenus", async () => {
    await db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, f.appt.id));
    await tick(NOW);
    expect(await db.select().from(relayTasks)).toHaveLength(0);

    const lone = await createMember(f.family, "Tante");
    await db.update(members).set({ status: "non_connecte" }).where(eq(members.id, lone.id));
    await db.insert(appointments).values({ memberId: lone.id, title: "Contrôle", appointmentDate: RDV, status: "confirmed" });
    await tick(NOW);
    expect((await notifsOf(f.awa)).map((n) => n.title)).toEqual(["À relayer : prévenir Tante Test de son rendez-vous"]);
  });
});
