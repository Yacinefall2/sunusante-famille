import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { medicationIntakes, notifications, treatments, treatmentMedications, vaccinations } from "../src/db/schema.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { addDays, localDate } from "../src/lib/time.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, grantRole, as } from "./helpers.js";

// Suivi des rappels de vaccin (à faire / en retard / fait) et fin
// automatique des traitements.
let f;
beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Fall");
  const papa = await createUser("Mouhamed");
  const membre = await createUser("Medoune");
  const papaM = await addMembership(papa, family, "parent", { isPrimaryAdmin: true });
  await addMembership(membre, family, "adult");
  await linkMember(papaM, await createMember(family, "Mouhamed"));
  const zahra = await createMember(family, "Zahra");
  await grantRole(zahra, papa, "gestionnaire");
  f = { family, papa, membre, zahra };
});

const vaccine = async (nextDoseDate) =>
  (await db.insert(vaccinations).values({ memberId: f.zahra.id, vaccineName: "ROR", dateAdministered: "2024-01-12", nextDoseDate }).returning())[0];
const statusOf = async (id) =>
  (await as(f.papa).get(`/api/vaccinations?familyId=${f.family.id}`)).body.find((v) => v.id === id)?.boosterStatus;

describe("Statut du rappel de vaccin", () => {
  it("à faire, puis en retard, puis fait avec « Rappel effectué »", async () => {
    const today = localDate();
    const upcoming = await vaccine(addDays(today, 10));
    const late = await vaccine(addDays(today, -3));
    const none = await vaccine(null);
    expect(await statusOf(upcoming.id)).toBe("a_faire");
    expect(await statusOf(late.id)).toBe("en_retard");
    expect(await statusOf(none.id)).toBeNull();

    const res = await as(f.papa).post(`/api/vaccinations/${late.id}/booster-done`).send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ vaccineName: "ROR", dateAdministered: today, memberId: f.zahra.id });
    expect(await statusOf(late.id)).toBe("fait");
    expect((await as(f.papa).post(`/api/vaccinations/${late.id}/booster-done`).send({})).status).toBe(409);
  });

  it("refuse une dose datée du futur, et un compte sans accès à la fiche", async () => {
    const v = await vaccine(addDays(localDate(), -1));
    expect((await as(f.papa).post(`/api/vaccinations/${v.id}/booster-done`).send({ dateAdministered: addDays(localDate(), 2) })).status).toBe(400);
    expect((await as(f.membre).post(`/api/vaccinations/${v.id}/booster-done`).send({})).status).toBe(403);
  });
});

describe("Relance d'un rappel en retard", () => {
  const tick = (now) => runReminderTick({ now, sendMail: async () => "<id@test>" });
  const titles = async () => (await db.select().from(notifications).where(eq(notifications.userId, f.papa.id))).map((n) => n.title);

  it("une relance 7 jours après la date, une seule fois ; rien si le rappel est fait", async () => {
    await vaccine("2026-11-01");
    await tick(new Date("2026-11-05T09:00:00Z"));
    expect((await titles()).some((t) => t.includes("en retard"))).toBe(false);
    await tick(new Date("2026-11-08T09:00:00Z"));
    await tick(new Date("2026-11-09T09:00:00Z"));
    expect((await titles()).filter((t) => t.startsWith("Rappel de vaccin en retard : ROR"))).toHaveLength(1);

  });

  it("aucune relance pour un rappel en retard déjà enregistré", async () => {
    const v = await vaccine("2026-11-01");
    const [dose] = await db.insert(vaccinations).values({ memberId: f.zahra.id, vaccineName: "ROR", dateAdministered: "2026-11-03" }).returning();
    await db.update(vaccinations).set({ boosterDoneVaccinationId: dose.id }).where(eq(vaccinations.id, v.id));
    await tick(new Date("2026-11-08T09:00:00Z"));
    expect(await titles()).toEqual([]);
  });

  it("pas de rappel J-7 pour un rappel déjà fait", async () => {
    const v = await vaccine("2026-11-10");
    await db.update(vaccinations).set({ boosterDoneVaccinationId: v.id }).where(eq(vaccinations.id, v.id));
    await tick(new Date("2026-11-05T09:00:00Z"));
    expect(await titles()).toEqual([]);
  });
});

describe("Fin automatique des traitements", () => {
  it("passe en « terminé » le lendemain de la date de fin, et les rappels s'arrêtent", async () => {
    const [t] = await db.insert(treatments).values({ memberId: f.zahra.id, disease: "Otite", isActive: true, endDate: "2026-11-05" }).returning();
    await db.insert(treatmentMedications).values({ treatmentId: t.id, name: "Amoxicilline", intakeTimes: ["08:00"] });
    await runReminderTick({ now: new Date("2026-11-05T20:00:00Z"), sendMail: async () => null });
    expect((await db.select().from(treatments).where(eq(treatments.id, t.id)))[0].isActive).toBe(true);
    await runReminderTick({ now: new Date("2026-11-06T08:01:00Z"), sendMail: async () => null });
    expect((await db.select().from(treatments).where(eq(treatments.id, t.id)))[0].isActive).toBe(false);
    const intakeTitles = (await db.select().from(notifications)).filter((n) => n.category === "medication_intake" && n.createdAt > new Date("2026-11-06"));
    expect(intakeTitles).toHaveLength(0);
  });
});

describe("Modifier un traitement conserve l'historique des prises", () => {
  it("les médicaments gardés sont mis à jour sur place ; seul un médicament retiré perd son historique", async () => {
    const created = await as(f.papa).post("/api/treatments").send({
      memberId: f.zahra.id,
      disease: "Otite",
      medications: [{ name: "Amoxicilline", intakeTimes: ["08:00"] }, { name: "Doliprane", intakeTimes: ["12:00"] }],
    });
    expect(created.status).toBe(201);
    const [amox, doli] = created.body.medications;
    await runReminderTick({ now: new Date(`${localDate()}T08:01:00Z`), sendMail: async () => null });
    await runReminderTick({ now: new Date(`${localDate()}T12:01:00Z`), sendMail: async () => null });
    const before = await db.select().from(medicationIntakes);
    expect(before.map((i) => i.medicationId).sort()).toEqual([amox.id, doli.id].sort());

    const edited = await as(f.papa).put("/api/treatments").send({
      id: created.body.id,
      disease: "Otite aiguë",
      medications: [{ id: amox.id, name: "Amoxicilline", dosage: "250 mg", intakeTimes: ["08:00", "20:00"] }, { name: "Sérum physiologique" }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.medications.find((m) => m.name === "Amoxicilline").id).toBe(amox.id);
    const after = await db.select().from(medicationIntakes);
    expect(after.map((i) => i.medicationId)).toEqual([amox.id]); // Doliprane retiré : son historique part avec lui
  });
});
