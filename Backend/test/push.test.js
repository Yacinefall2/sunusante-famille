import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import {
  intakeActionTokens,
  medicationIntakes,
  notificationPreferences,
  notifications,
  pushSubscriptions,
  treatmentMedications,
  treatments,
} from "../src/db/schema.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { NEUTRAL_TITLE } from "../src/lib/push.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, as } from "./helpers.js";

// Le module web-push est simulé : aucun message ne part réellement vers un
// service push. On vérifie à qui, et avec quel contenu, il serait parti.
const webpush = vi.hoisted(() => ({ sendNotification: vi.fn(), setVapidDetails: vi.fn() }));
vi.mock("web-push", () => ({ default: webpush }));

const at = (iso) => new Date(iso);
const tick = (now) => runReminderTick({ now, sendMail: async () => "<id>" });

const VAPID = {
  VAPID_PUBLIC_KEY: "BPublicKeyDeTest_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  VAPID_PRIVATE_KEY: "clePriveeDeTest_0123456789abcdef",
  VAPID_SUBJECT: "mailto:contact@santefamille.local",
};
const setVapid = (on) => {
  for (const [k, v] of Object.entries(VAPID)) {
    if (on) process.env[k] = v;
    else delete process.env[k];
  }
};

// Abonnement tel que l'envoie le navigateur (PushSubscription.toJSON()).
const browserSubscription = (n) => ({
  endpoint: `https://push.example.test/abonnement-${n}`,
  keys: { p256dh: `B${"p".repeat(86)}${n}`, auth: `auth-secret-${n}` },
});

const subscribe = (user, n, extra = {}) =>
  as(user)
    .post("/api/push/subscriptions")
    .set("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36")
    .send({ ...browserSubscription(n), ...extra });

const sentTo = () => webpush.sendNotification.mock.calls.map(([sub]) => sub.endpoint);
const sentPayloads = () => webpush.sendNotification.mock.calls.map(([, payload]) => JSON.parse(payload));

let f;
beforeEach(async () => {
  await resetDatabase();
  setVapid(true);
  webpush.sendNotification.mockReset();
  webpush.sendNotification.mockResolvedValue({ statusCode: 201 });
  const family = await createFamily("Diallo");
  const awa = await createUser("Awa");
  const binta = await createUser("Binta");
  const fiche = await createMember(family, "Awa");
  await linkMember(await addMembership(awa, family, "parent", { isPrimaryAdmin: true }), fiche);
  const bintaFiche = await createMember(family, "Binta");
  await linkMember(await addMembership(binta, family, "adult"), bintaFiche);
  const [t] = await db
    .insert(treatments)
    .values({ memberId: fiche.id, disease: "Diabète", isActive: true, createdAt: at("2026-11-01T00:00:00Z") })
    .returning();
  const [med] = await db
    .insert(treatmentMedications)
    .values({ treatmentId: t.id, name: "Metformine", dosage: "500 mg", intakeTimes: ["08:00"], createdAt: at("2026-11-01T00:00:00Z") })
    .returning();
  f = { family, awa, binta, fiche, med };
});

afterEach(() => setVapid(false));

const intakeOfTheDay = async () => (await db.select().from(medicationIntakes).where(eq(medicationIntakes.medicationId, f.med.id)))[0];

describe("Abonnement d'un appareil", () => {
  it("abonne, liste, règle « masquer le détail » puis désabonne cet appareil", async () => {
    const res = await subscribe(f.awa, 1);
    expect(res.status).toBe(201);
    expect(res.body.label).toBe("Chrome sur Android");
    expect(res.body.hideDetails).toBe(false);

    const list = await as(f.awa).get("/api/push/subscriptions");
    expect(list.body).toHaveLength(1);
    // Un autre compte ne voit pas cet appareil
    expect((await as(f.binta).get("/api/push/subscriptions")).body).toHaveLength(0);

    const put = await as(f.awa).put(`/api/push/subscriptions/${res.body.id}`).send({ hideDetails: true });
    expect(put.body.hideDetails).toBe(true);
    // … ni ne peut le modifier ou le retirer
    expect((await as(f.binta).put(`/api/push/subscriptions/${res.body.id}`).send({ hideDetails: false })).status).toBe(404);
    expect((await as(f.binta).delete(`/api/push/subscriptions/${res.body.id}`)).status).toBe(404);

    await as(f.awa).delete("/api/push/subscriptions").send({ endpoint: browserSubscription(1).endpoint });
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it("refuse un abonnement mal formé ou hors HTTPS, et exige une session", async () => {
    expect((await as(f.awa).post("/api/push/subscriptions").send({ endpoint: "http://x.test/a", keys: browserSubscription(1).keys })).status).toBe(400);
    expect((await as(f.awa).post("/api/push/subscriptions").send({ endpoint: browserSubscription(1).endpoint })).status).toBe(400);
    expect((await request(app).post("/api/push/subscriptions").send(browserSubscription(1))).status).toBe(401);
  });

  it("le même navigateur réabonné par un autre compte change de propriétaire", async () => {
    await subscribe(f.awa, 1);
    await subscribe(f.binta, 1);
    const rows = await db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(f.binta.id);
  });

  it("retirer un appareil de la liste « Mes appareils »", async () => {
    const { body } = await subscribe(f.awa, 1);
    expect((await as(f.awa).delete(`/api/push/subscriptions/${body.id}`)).status).toBe(200);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it("notification de test envoyée à cet appareil", async () => {
    await subscribe(f.awa, 1);
    const res = await as(f.awa).post("/api/push/test").send({ endpoint: browserSubscription(1).endpoint });
    expect(res.status).toBe(200);
    expect(sentPayloads()[0].title).toBe("Notification de test");
    // Pas l'appareil d'un autre compte
    expect((await as(f.binta).post("/api/push/test").send({ endpoint: browserSubscription(1).endpoint })).status).toBe(404);
  });
});

describe("Envoi des rappels en push", () => {
  it("un rappel de prise part vers les appareils de son destinataire seulement", async () => {
    await subscribe(f.awa, 1);
    await subscribe(f.awa, 2);
    await subscribe(f.binta, 3);
    await tick(at("2026-11-10T08:01:00Z"));

    expect(sentTo().sort()).toEqual([browserSubscription(1).endpoint, browserSubscription(2).endpoint]);
    const [payload] = sentPayloads();
    expect(payload.title).toBe("C'est l'heure : Metformine 500 mg");
    expect(payload.intakeId).toBe((await intakeOfTheDay()).id);
    expect(payload.actionToken).toEqual(expect.any(String));
    const intake = await intakeOfTheDay();
    expect(payload.tag).toBe(`prise-${f.med.id}-${intake.scheduledAt.getTime()}`);
    // Un seul jeton pour les deux appareils
    expect(sentPayloads()[1].actionToken).toBe(payload.actionToken);
    expect(await db.select().from(intakeActionTokens)).toHaveLength(1);

    const [n] = await db.select().from(notifications).where(eq(notifications.userId, f.awa.id));
    expect(n.pushStatus).toBe("sent");

    // Passage suivant : rien n'est renvoyé
    await tick(at("2026-11-10T08:02:00Z"));
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  it("respecte la préférence « Dans l'application » de la catégorie", async () => {
    await subscribe(f.awa, 1);
    await db.insert(notificationPreferences).values({ userId: f.awa.id, category: "medication_intake", inApp: false, email: true });
    await tick(at("2026-11-10T08:01:00Z"));
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, f.awa.id));
    expect(n.pushStatus).toBe("skipped");
  });

  it("un abonnement expiré (410) est supprimé", async () => {
    await subscribe(f.awa, 1);
    await subscribe(f.awa, 2);
    webpush.sendNotification.mockImplementation(async (sub) => {
      if (sub.endpoint.endsWith("-1")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      return { statusCode: 201 };
    });
    await tick(at("2026-11-10T08:01:00Z"));
    const left = await db.select().from(pushSubscriptions);
    expect(left.map((s) => s.endpoint)).toEqual([browserSubscription(2).endpoint]);
    expect(left[0].lastSuccessAt).not.toBeNull();
  });

  it("« masquer le détail » : titre neutre, sans médicament ni boutons", async () => {
    await subscribe(f.awa, 1, { hideDetails: true });
    await tick(at("2026-11-10T08:01:00Z"));
    const [payload] = sentPayloads();
    expect(payload.title).toBe(NEUTRAL_TITLE);
    expect(JSON.stringify(payload)).not.toContain("Metformine");
    expect(payload.actionToken).toBeNull();
    expect(await db.select().from(intakeActionTokens)).toHaveLength(0);
  });

  it("sans clés VAPID : push désactivé, sans erreur", async () => {
    setVapid(false);
    await subscribe(f.awa, 1); // refusé (503), sans planter
    await db.insert(pushSubscriptions).values({ userId: f.awa.id, endpoint: browserSubscription(1).endpoint, p256dh: "x", auth: "y" });
    await expect(tick(at("2026-11-10T08:01:00Z"))).resolves.toBeUndefined();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, f.awa.id));
    expect(n.pushStatus).toBe("skipped");
    const key = await as(f.awa).get("/api/push/public-key");
    expect(key.body).toEqual({ enabled: false, publicKey: null });
    expect((await subscribe(f.awa, 2)).status).toBe(503);
  });
});

describe("Boutons « Pris » / « Pas pris » de la notification (jeton d'action)", () => {
  const respond = (intakeId, body) => request(app).post(`/api/intakes/${intakeId}/respond-with-token`).send(body);

  beforeEach(async () => {
    await subscribe(f.awa, 1);
    await tick(at("2026-11-10T08:01:00Z"));
    f.token = sentPayloads()[0].actionToken;
    f.intake = await intakeOfTheDay();
  });

  it("« Pris » accepté sans session, une seule fois", async () => {
    const res = await respond(f.intake.id, { token: f.token, status: "taken" });
    expect(res.status).toBe(200);
    const intake = await intakeOfTheDay();
    expect(intake.status).toBe("taken");
    expect(intake.respondedByUserId).toBe(f.awa.id);
    // La notification de la prise est marquée lue
    const [n] = await db.select().from(notifications).where(eq(notifications.intakeId, f.intake.id));
    expect(n.readAt).not.toBeNull();
    // Jeton à usage unique
    expect((await respond(f.intake.id, { token: f.token, status: "not_taken" })).status).toBe(401);
    expect((await intakeOfTheDay()).status).toBe("taken");
  });

  it("mauvais statut refusé, sans consommer le jeton", async () => {
    expect((await respond(f.intake.id, { token: f.token, status: "missed" })).status).toBe(400);
    expect((await respond(f.intake.id, { token: f.token, status: "not_taken" })).status).toBe(200);
  });

  it("jeton limité à sa prise : refusé pour une autre", async () => {
    const [other] = await db
      .insert(medicationIntakes)
      .values({ medicationId: f.med.id, memberId: f.fiche.id, scheduledAt: at("2026-11-10T20:00:00Z") })
      .returning();
    expect((await respond(other.id, { token: f.token, status: "taken" })).status).toBe(401);
    expect((await db.select().from(medicationIntakes).where(eq(medicationIntakes.id, other.id)))[0].status).toBe("pending");
  });

  it("jeton expiré refusé", async () => {
    await db.update(intakeActionTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await respond(f.intake.id, { token: f.token, status: "taken" })).status).toBe(401);
    expect((await intakeOfTheDay()).status).toBe("pending");
  });

  it("jeton inconnu ou absent refusé", async () => {
    expect((await respond(f.intake.id, { token: "x".repeat(43), status: "taken" })).status).toBe(401);
    expect((await respond(f.intake.id, { status: "taken" })).status).toBe(401);
  });
});
