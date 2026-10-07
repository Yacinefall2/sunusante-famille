import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import {
  appointments,
  medicationIntakes,
  notifications,
  treatmentMedications,
  treatments,
  vaccinations,
} from "../src/db/schema.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, grantRole, as } from "./helpers.js";

// Le fuseau de référence est Africa/Dakar (UTC+0) : les heures ci-dessous
// sont donc les mêmes en UTC et en heure locale.
const at = (iso) => new Date(iso);
const hoursFrom = (date, h) => new Date(date.getTime() + h * 3600 * 1000);

// Boîte d'envoi factice : enregistre les courriels, ou échoue sur demande.
function fakeMailer({ fail = false } = {}) {
  const sent = [];
  const sendMail = async (mail) => {
    if (fail) throw new Error("Adresse refusée par le serveur");
    sent.push(mail);
    return `<msg-${sent.length}@test>`;
  };
  return { sent, sendMail };
}
const tick = (now, mailer = fakeMailer()) => runReminderTick({ now, sendMail: mailer.sendMail });

let f;
beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Ndiaye");
  const awa = await createUser("Awa"); // A1
  const fatou = await createUser("Fatou"); // membre, gestionnaire du grand-père
  const khady = await createUser("Khady"); // adolescente
  const awaM = await addMembership(awa, family, "parent", { isPrimaryAdmin: true });
  await addMembership(fatou, family, "adult");
  const khadyM = await addMembership(khady, family, "dependent");
  const fiches = {
    awa: await createMember(family, "Awa"),
    khady: await createMember(family, "Khady"),
    grandPere: await createMember(family, "Grand-père"),
  };
  await linkMember(awaM, fiches.awa);
  await linkMember(khadyM, fiches.khady);
  await grantRole(fiches.grandPere, fatou, "gestionnaire");
  await grantRole(fiches.khady, awa, "gestionnaire");
  f = { family, awa, fatou, khady, fiches };
});

const notifsOf = (user) =>
  db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(notifications.id);

describe("Rappels de rendez-vous (J-3, J-1)", () => {
  async function appointment(member, date, extra = {}) {
    const [a] = await db
      .insert(appointments)
      .values({ memberId: member.id, title: "Cardiologie", doctorName: "Dr Mbaye", location: "Kolda", appointmentDate: date, status: "confirmed", ...extra })
      .returning();
    return a;
  }

  it("J-3 puis J-1, envoyés au gestionnaire, sans doublon", async () => {
    const now = at("2026-11-10T09:00:00Z");
    await appointment(f.fiches.grandPere, hoursFrom(now, 70));
    await tick(now);
    await tick(hoursFrom(now, 0.1));
    let list = await notifsOf(f.fatou);
    expect(list).toHaveLength(1);
    expect(list[0].title).toMatch(/^Dans 3 jours : Cardiologie — Grand-père/);
    expect(list[0].body).toContain("Avec Dr Mbaye");

    await tick(hoursFrom(now, 50)); // 20 h avant, la veille
    list = await notifsOf(f.fatou);
    expect(list.map((n) => n.title.split(" :")[0])).toEqual(["Dans 3 jours", "Demain"]);
    expect(await notifsOf(f.awa)).toHaveLength(0); // A1 n'est pas gestionnaire du grand-père
  });

  it("le titre donne le délai réel : un rendez-vous dans 30 h est « Demain »", async () => {
    const now = at("2026-11-10T09:00:00Z");
    await appointment(f.fiches.grandPere, hoursFrom(now, 30));
    await tick(now);
    const [n] = await notifsOf(f.fatou);
    expect(n.title).toMatch(/^Demain : Cardiologie/);
  });

  it("rien pour un rendez-vous annulé, passé ou à plus de 3 jours", async () => {
    const now = at("2026-11-10T09:00:00Z");
    await appointment(f.fiches.grandPere, hoursFrom(now, 30), { status: "cancelled" });
    await appointment(f.fiches.grandPere, hoursFrom(now, -2));
    await appointment(f.fiches.grandPere, hoursFrom(now, 100));
    await tick(now);
    expect(await notifsOf(f.fatou)).toHaveLength(0);
  });

  it("le titulaire et les gestionnaires d'une fiche sont prévenus", async () => {
    const now = at("2026-11-10T09:00:00Z");
    await appointment(f.fiches.khady, hoursFrom(now, 10));
    await tick(now);
    expect(await notifsOf(f.khady)).toHaveLength(1);
    expect(await notifsOf(f.awa)).toHaveLength(1);
  });
});

describe("Préférences et courriels (UC-65, UC-66, UC-67)", () => {
  const futureAppointment = (now) =>
    db.insert(appointments).values({ memberId: f.fiches.grandPere.id, title: "Contrôle", appointmentDate: hoursFrom(now, 10), status: "confirmed" });

  it("envoie le courriel du rappel de rendez-vous (activé par défaut)", async () => {
    const now = at("2026-11-10T09:00:00Z");
    await futureAppointment(now);
    const mailer = fakeMailer();
    await tick(now, mailer);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: f.fatou.email, link: "/rendez-vous" });
    expect(mailer.sent[0].subject).toMatch(/^SunuSanté Famille — Aujourd'hui : Contrôle/);
    const [n] = await notifsOf(f.fatou);
    expect(n).toMatchObject({ emailStatus: "sent", emailMessageId: "<msg-1@test>" });
  });

  it("respecte les préférences : courriel coupé, ou rien du tout", async () => {
    const now = at("2026-11-10T09:00:00Z");
    await futureAppointment(now);
    await as(f.fatou).put("/api/notifications/preferences").send({ category: "appointment_reminder", inApp: true, email: false });
    const mailer = fakeMailer();
    await tick(now, mailer);
    expect(mailer.sent).toHaveLength(0);
    expect((await notifsOf(f.fatou))[0].emailStatus).toBe("skipped");

    await db.delete(notifications);
    await as(f.fatou).put("/api/notifications/preferences").send({ category: "appointment_reminder", inApp: false, email: false });
    await tick(now, mailer);
    expect(await notifsOf(f.fatou)).toHaveLength(0);
  });

  it("3 tentatives espacées, puis échec signalé à la personne et à A1 — jamais silencieux", async () => {
    const now = at("2026-11-10T09:00:00Z");
    await futureAppointment(now);
    const failing = fakeMailer({ fail: true });
    await tick(now, failing);
    let [n] = await notifsOf(f.fatou);
    expect(n).toMatchObject({ emailStatus: "pending", emailAttempts: 1 });

    await tick(hoursFrom(now, 1 / 60), failing); // 1 min après : trop tôt pour réessayer
    [n] = await notifsOf(f.fatou);
    expect(n.emailAttempts).toBe(1);

    await tick(hoursFrom(now, 0.1), failing); // +6 min
    await tick(hoursFrom(now, 0.3), failing); // +18 min
    const fatouList = await notifsOf(f.fatou);
    expect(fatouList[0]).toMatchObject({ emailStatus: "failed", emailAttempts: 3 });
    expect(fatouList[1]).toMatchObject({ category: "delivery_failure", inApp: true });
    const awaList = await notifsOf(f.awa);
    expect(awaList).toHaveLength(1);
    expect(awaList[0].title).toContain(f.fatou.email);
  });
});

describe("Rappels de prise de médicament (UC-56, UC-20, UC-44)", () => {
  async function medication(member, times) {
    const [t] = await db.insert(treatments).values({ memberId: member.id, disease: "Hypertension", isActive: true }).returning();
    const [m] = await db.insert(treatmentMedications).values({ treatmentId: t.id, name: "Amlodipine", dosage: "5 mg", intakeTimes: times }).returning();
    return m;
  }

  it("rappel à l'heure au titulaire seulement, une relance après 30 min, puis plus rien", async () => {
    await medication(f.fiches.khady, ["08:00"]);
    await tick(at("2026-11-10T07:59:00Z"));
    expect(await notifsOf(f.khady)).toHaveLength(0);

    await tick(at("2026-11-10T08:01:00Z"));
    let list = await notifsOf(f.khady);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("C'est l'heure : Amlodipine 5 mg");
    expect(list[0].emailStatus).toBe("skipped"); // pas de courriel par défaut pour les prises
    expect(await notifsOf(f.awa)).toHaveLength(0); // la titulaire existe : elle seule est prévenue

    await tick(at("2026-11-10T08:20:00Z"));
    expect(await notifsOf(f.khady)).toHaveLength(1);
    await tick(at("2026-11-10T08:32:00Z"));
    list = await notifsOf(f.khady);
    expect(list.map((n) => n.title)).toEqual(["C'est l'heure : Amlodipine 5 mg", "Relance : Amlodipine 5 mg (prise de 08:00)"]);
    await tick(at("2026-11-10T09:30:00Z"));
    expect(await notifsOf(f.khady)).toHaveLength(2);
  });

  it("pour une fiche sans compte, ce sont les gestionnaires qui sont prévenus", async () => {
    await medication(f.fiches.grandPere, ["20:00"]);
    await tick(at("2026-11-10T20:00:30Z"));
    expect(await notifsOf(f.fatou)).toHaveLength(1);
  });

  it("ne rattrape pas une prise de plus de 2 h ; marque « sans réponse » au bout de 12 h", async () => {
    const med = await medication(f.fiches.khady, ["08:00", "14:00"]);
    await tick(at("2026-11-10T14:05:00Z")); // 08:00 trop ancienne, 14:00 oui
    const intakes = await db.select().from(medicationIntakes).where(eq(medicationIntakes.medicationId, med.id));
    expect(intakes.map((i) => i.scheduledAt.toISOString())).toEqual(["2026-11-10T14:00:00.000Z"]);
    await tick(at("2026-11-11T02:30:00Z"));
    const [after] = await db.select().from(medicationIntakes).where(eq(medicationIntakes.medicationId, med.id));
    expect(after.status).toBe("missed");
  });

  it("l'adolescente répond « pris » : historique gardé, notifications lues, plus de relance", async () => {
    await medication(f.fiches.khady, ["08:00"]);
    await tick(at("2026-11-10T08:01:00Z"));
    const [intake] = await db.select().from(medicationIntakes);

    const outsider = await createUser("Externe");
    await addMembership(outsider, f.family, "adult");
    expect((await as(outsider).post(`/api/intakes/${intake.id}/respond`).send({ status: "taken" })).status).toBe(403);
    expect((await as(f.khady).post(`/api/intakes/${intake.id}/respond`).send({ status: "peut-être" })).status).toBe(400);
    const res = await as(f.khady).post(`/api/intakes/${intake.id}/respond`).send({ status: "taken" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "taken", respondedByUserId: f.khady.id });

    const [n] = await notifsOf(f.khady);
    expect(n.readAt).not.toBeNull();
    await tick(at("2026-11-10T08:40:00Z"));
    expect(await notifsOf(f.khady)).toHaveLength(1);

    const history = await as(f.awa).get(`/api/intakes?memberId=${f.fiches.khady.id}&days=3650`);
    expect(history.status).toBe(200);
    expect(history.body[0]).toMatchObject({ medicationName: "Amlodipine", status: "taken" });
  });
});

describe("Rappels de vaccin (7 jours avant)", () => {
  it("prévient dans les 7 jours avant la prochaine dose, pas avant", async () => {
    await db.insert(vaccinations).values([
      { memberId: f.fiches.grandPere.id, vaccineName: "Grippe", dateAdministered: "2025-11-01", nextDoseDate: "2026-11-15" },
      { memberId: f.fiches.grandPere.id, vaccineName: "Tétanos", dateAdministered: "2025-11-01", nextDoseDate: "2026-11-25" },
    ]);
    await tick(at("2026-11-10T09:00:00Z"));
    const list = await notifsOf(f.fatou);
    expect(list.map((n) => n.title)).toEqual(["Rappel de vaccin : Grippe — Grand-père Test"]);
  });
});

describe("API des notifications", () => {
  it("chacun ne voit et ne lit que les siennes", async () => {
    await db.insert(appointments).values({ memberId: f.fiches.grandPere.id, title: "Contrôle", appointmentDate: hoursFrom(new Date(), 10), status: "confirmed" });
    await tick(new Date());
    const mine = await as(f.fatou).get("/api/notifications");
    expect(mine.body.unreadCount).toBe(1);
    const id = mine.body.items[0].id;
    expect((await as(f.awa).post(`/api/notifications/${id}/read`)).status).toBe(404);
    expect((await as(f.fatou).post(`/api/notifications/${id}/read`)).status).toBe(200);
    expect((await as(f.fatou).get("/api/notifications")).body.unreadCount).toBe(0);
    expect((await as(f.awa).get("/api/notifications")).body.items).toHaveLength(0);
  });

  it("préférences : une ligne par catégorie, catégorie inconnue refusée", async () => {
    const prefs = (await as(f.fatou).get("/api/notifications/preferences")).body;
    expect(prefs.map((p) => [p.category, p.inApp, p.email])).toEqual([
      ["appointment_reminder", true, true],
      ["medication_intake", true, false],
      ["vaccine_reminder", true, true],
      ["relay_to_relay", true, true],
      ["relay_escalation", true, true],
      ["relay_alert", true, true],
      ["relay_update", true, false],
      ["doctor_share", true, true],
      ["emergency_view", true, true],
    ]);
    expect((await as(f.fatou).put("/api/notifications/preferences").send({ category: "delivery_failure", inApp: false, email: false })).status).toBe(400);
  });
});

describe("Rebonds signalés par le service d'envoi", () => {
  it("adresse secrète requise ; un rebond marque l'échec et prévient", async () => {
    process.env.MAIL_WEBHOOK_SECRET = "secret-test";
    const now = new Date();
    await db.insert(appointments).values({ memberId: f.fiches.grandPere.id, title: "Contrôle", appointmentDate: hoursFrom(now, 10), status: "confirmed" });
    await tick(now);
    const { default: request } = await import("supertest");
    const { default: app } = await import("../src/app.js");
    expect((await request(app).post("/api/webhooks/mail/mauvais").send({})).status).toBe(404);
    const res = await request(app)
      .post("/api/webhooks/mail/secret-test")
      .send({ event: "hard_bounce", "message-id": "<msg-1@test>", reason: "550 user unknown" });
    expect(res.status).toBe(200);
    const list = await notifsOf(f.fatou);
    expect(list[0].emailStatus).toBe("failed");
    expect(list[0].emailLastError).toContain("Adresse inexistante");
    expect(list.some((n) => n.category === "delivery_failure")).toBe(true);
  });
});
