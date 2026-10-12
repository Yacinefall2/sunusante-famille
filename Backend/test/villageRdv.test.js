import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { appointments, documentRoles, members, notifications, relayEvents, relayTasks } from "../src/db/schema.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, grantRole, as } from "./helpers.js";

const plusH = (d, h) => new Date(d.getTime() + h * 3600 * 1000);
const tick = (now) => runReminderTick({ now, sendMail: async () => "<id@test>" });
const notifsOf = (user) => db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(notifications.id);
const eventsOf = async (task) => (await db.select().from(relayEvents).where(eq(relayEvents.taskId, task.id)).orderBy(relayEvents.id)).map((e) => e.type);

// Foyer : Awa (A1), Fatou (gestionnaire du grand-père), Moussa (relais),
// grand-père « non connecté ». Le rendez-vous est dans le futur réel, pour
// que les routes (qui travaillent à l'heure réelle) le voient « à venir ».
const NOW = new Date("2026-11-10T09:00:00Z");
const RDV = plusH(NOW, 70);
let f;
beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Ba");
  const [awa, fatou, moussa] = await Promise.all(["Awa", "Fatou", "Moussa"].map((n) => createUser(n)));
  await linkMember(await addMembership(awa, family, "parent", { isPrimaryAdmin: true }), await createMember(family, "Awa"));
  await addMembership(fatou, family, "adult");
  await addMembership(moussa, family, "adult");
  const gp = await createMember(family, "Grand-père");
  await db.update(members).set({ status: "non_connecte" }).where(eq(members.id, gp.id));
  await grantRole(gp, fatou, "gestionnaire");
  await grantRole(gp, moussa, "relais");
  const [appt] = await db
    .insert(appointments)
    .values({ memberId: gp.id, title: "Cardiologie", location: "Hôpital de Kolda", appointmentDate: RDV, status: "confirmed" })
    .returning();
  f = { family, awa, fatou, moussa, gp, appt };
});

async function escalated() {
  await tick(NOW);
  await tick(plusH(NOW, 47));
  await tick(plusH(NOW, 50));
  const [task] = await db.select().from(relayTasks);
  return task;
}

describe("Point 12 — rendez-vous annulé ou déplacé", () => {
  it("annulation : tâche close, notifications lues, gestionnaire et relais prévenus, badge et tableau de bord à jour", async () => {
    const task = await escalated();
    const res = await as(f.awa).put("/api/appointments").send({ id: f.appt.id, status: "cancelled" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: "Cardiologie", location: "Hôpital de Kolda" }); // champs absents conservés

    for (const u of [f.fatou, f.moussa]) {
      const list = await notifsOf(u);
      const update = list.find((n) => n.category === "relay_update");
      expect(update.title).toBe("Rendez-vous de Grand-père Test annulé");
      expect(update.body).not.toContain("Cardiologie");
      expect(list.filter((n) => n.dedupeKey.startsWith(`relay:${task.id}:`)).every((n) => n.readAt)).toBe(true);
    }
    expect(await eventsOf(task)).toContain("cancelled");

    const badge = (await as(f.fatou).get(`/api/members?familyId=${f.family.id}`)).body.find((m) => m.id === f.gp.id);
    expect(badge.relayPending).toBe(false);
    const dash = (await as(f.awa).get(`/api/dashboard/family?familyId=${f.family.id}`)).body;
    expect(dash.todo.some((t) => t.type === "relay")).toBe(false);

    // « Prévenu » / « Pas joignable » refusés sur une tâche périmée.
    expect((await as(f.moussa).post(`/api/village/tasks/${task.id}/notified`)).status).toBe(409);
    expect((await as(f.fatou).post(`/api/village/tasks/${task.id}/unreachable`)).status).toBe(409);
  });

  it("déplacement : prévenus de la nouvelle date, nouvelle tâche à la nouvelle date", async () => {
    const task = await escalated();
    const newDate = plusH(RDV, 24);
    const res = await as(f.fatou).put("/api/appointments").send({ id: f.appt.id, appointmentDate: newDate.toISOString() });
    expect(res.status).toBe(200);
    expect(await eventsOf(task)).toContain("moved");
    const update = (await notifsOf(f.moussa)).find((n) => n.category === "relay_update");
    expect(update.title).toBe("Rendez-vous de Grand-père Test déplacé");
    expect(await notifsOf(f.fatou).then((l) => l.some((n) => n.category === "relay_update"))).toBe(false); // l'auteur n'est pas prévenu de son propre changement
    expect((await as(f.moussa).post(`/api/village/tasks/${task.id}/notified`)).status).toBe(409);

    await tick(plusH(NOW, 51));
    const tasks = await db.select().from(relayTasks).orderBy(relayTasks.id);
    expect(tasks).toHaveLength(2);
    expect(tasks[1].appointmentDate.getTime()).toBe(newDate.getTime());
  });

  it("suppression d'un rendez-vous : traitée comme une annulation", async () => {
    await escalated();
    expect((await as(f.awa).delete(`/api/appointments?id=${f.appt.id}`)).status).toBe(200);
    expect((await notifsOf(f.moussa)).some((n) => n.title === "Rendez-vous de Grand-père Test annulé")).toBe(true);
  });

  it("présence saisie par la modification complète : tracée dans l'historique du Village", async () => {
    const past = plusH(new Date(), -14);
    await db.update(appointments).set({ appointmentDate: past }).where(eq(appointments.id, f.appt.id));
    await tick(plusH(past, -70));
    const res = await as(f.fatou).put("/api/appointments").send({ id: f.appt.id, attendance: "missed" });
    expect(res.status).toBe(200);
    const [task] = await db.select().from(relayTasks);
    expect(await eventsOf(task)).toContain("missed");
  });
});

describe("Point 12 — cycle du Village", () => {
  it("pas de relance dans le même passage que la création de la tâche", async () => {
    await db.update(appointments).set({ appointmentDate: plusH(NOW, 20) }).where(eq(appointments.id, f.appt.id));
    await tick(NOW);
    expect((await notifsOf(f.fatou)).map((n) => n.title.split(" :")[0])).toEqual(["À relayer"]);
    await tick(plusH(NOW, 0.5));
    expect(await notifsOf(f.fatou)).toHaveLength(1);
    await tick(plusH(NOW, 1));
    expect((await notifsOf(f.fatou)).map((n) => n.title.split(" :")[0])).toEqual(["À relayer", "Relance"]);
  });

  it("« Pas joignable » répété dans l'heure : une seule alerte", async () => {
    const task = await escalated();
    expect((await as(f.moussa).post(`/api/village/tasks/${task.id}/unreachable`)).status).toBe(200);
    expect((await as(f.moussa).post(`/api/village/tasks/${task.id}/unreachable`)).status).toBe(200);
    const alerts = (await notifsOf(f.fatou)).filter((n) => n.category === "relay_alert");
    expect(alerts).toHaveLength(1);
  });

  it("escalade sans relais désigné : les gestionnaires en sont avertis", async () => {
    await db.delete(documentRoles).where(eq(documentRoles.userId, f.moussa.id));
    const task = await escalated();
    expect(await eventsOf(task)).toEqual(["to_relay", "follow_up", "no_relay"]);
    const alert = (await notifsOf(f.fatou)).find((n) => n.category === "relay_alert");
    expect(alert.title).toBe("Aucun relais désigné pour prévenir Grand-père Test");
  });

  it("identifiant de tâche invalide : 400", async () => {
    expect((await as(f.fatou).post("/api/village/tasks/abc/notified")).status).toBe(400);
  });
});

describe("Point 13 — fiche reliée à un compte : plus de Village", () => {
  it("une fiche « non connecté » qui a désormais un titulaire reçoit les rappels classiques", async () => {
    const gpUser = await createUser("Grand-père");
    await linkMember(await addMembership(gpUser, f.family, "adult"), f.gp);
    await tick(NOW);
    expect(await db.select().from(relayTasks)).toHaveLength(0);
    const [n] = await notifsOf(gpUser);
    expect(n.category).toBe("appointment_reminder");
  });
});

describe("Point 11 — rappels sans titulaire ni gestionnaire", () => {
  it("les parents du foyer sont prévenus ; rien pour une fiche archivée", async () => {
    const lone = await createMember(f.family, "Tante");
    await db.insert(appointments).values({ memberId: lone.id, title: "Contrôle", appointmentDate: plusH(NOW, 30) });
    await tick(NOW);
    const forAwa = (await notifsOf(f.awa)).filter((n) => n.memberId === lone.id);
    expect(forAwa).toHaveLength(1);
    expect(forAwa[0].category).toBe("appointment_reminder");

    const other = await createMember(f.family, "Cousin");
    await db.update(members).set({ archivedAt: new Date() }).where(eq(members.id, other.id));
    await db.insert(appointments).values({ memberId: other.id, title: "Contrôle", appointmentDate: plusH(NOW, 30) });
    await tick(plusH(NOW, 0.1));
    expect(await db.select().from(notifications).where(eq(notifications.memberId, other.id))).toHaveLength(0);
  });
});
