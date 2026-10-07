import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { appointments, medicationIntakes, members, relayTasks, treatmentMedications, treatments, vaccinations } from "../src/db/schema.js";
import { addDays, localDate, zonedTime } from "../src/lib/time.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, as } from "./helpers.js";

// Tableau de bord des parents : vue d'ensemble de la famille.
let f;
beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Fall");
  const [papa, maman, medoune] = await Promise.all(["Mouhamed", "Dior", "Medoune"].map((n) => createUser(n)));
  const pm = await addMembership(papa, family, "parent", { isPrimaryAdmin: true });
  const mm = await addMembership(maman, family, "parent");
  const sm = await addMembership(medoune, family, "adult");
  const fiche = async (firstName, data, membership) => {
    const m = await createMember(family, firstName);
    await db.update(members).set(data).where(eq(members.id, m.id));
    if (membership) await linkMember(membership, m);
    return { ...m, ...data };
  };
  const fPapa = await fiche("Mouhamed", { gender: "M", dateOfBirth: "1966-12-11", kinship: "parent" }, pm);
  const fMaman = await fiche("Dior", { gender: "F", dateOfBirth: "1976-04-22", kinship: "parent" }, mm);
  const fMedoune = await fiche("Medoune", { gender: "M", dateOfBirth: "2004-06-10", kinship: "enfant" }, sm);
  const fToutou = await fiche("Toutou", { gender: "F", dateOfBirth: "2012-08-25", kinship: "enfant" });
  const fZahra = await fiche("Zahra", { gender: "F", dateOfBirth: "2023-01-12", kinship: null }); // à compléter
  f = { family, papa, maman, medoune, fPapa, fMaman, fMedoune, fToutou, fZahra };
});

const today = () => localDate();
const get = (user) => as(user).get(`/api/dashboard/family?familyId=${f.family.id}`);

describe("Accès", () => {
  it("réservé aux parents", async () => {
    expect((await get(f.medoune)).status).toBe(403);
    expect((await get(f.papa)).status).toBe(200);
  });

  it("la fiche de l'autre parent reste privée, et rien d'elle ne fuit", async () => {
    await db.insert(appointments).values({ memberId: f.fMaman.id, title: "Gynécologie secrète", appointmentDate: new Date(Date.now() + 2 * 86400000), status: "confirmed" });
    const res = await get(f.papa);
    const dior = res.body.members.find((m) => m.id === f.fMaman.id);
    expect(dior).toMatchObject({ private: true, light: null });
    expect(dior).not.toHaveProperty("nextAppointment");
    expect(JSON.stringify(res.body)).not.toContain("Gynécologie secrète");
    expect(res.body.counts).toMatchObject({ members: 5, accounts: 3, readable: 4 });
  });
});

describe("À traiter", () => {
  it("rassemble tout ce qui attend une action, du plus urgent au moins urgent", async () => {
    const [t] = await db.insert(treatments).values({ memberId: f.fToutou.id, disease: "Carence en fer", isActive: true }).returning();
    const [med] = await db.insert(treatmentMedications).values({ treatmentId: t.id, name: "Fer", intakeTimes: ["00:01"] }).returning();
    await db.insert(medicationIntakes).values({ medicationId: med.id, memberId: f.fToutou.id, scheduledAt: zonedTime(today(), "00:01"), status: "pending" });
    await db.insert(vaccinations).values({ memberId: f.fToutou.id, vaccineName: "HPV", dateAdministered: "2026-01-01", nextDoseDate: addDays(today(), -5) });
    await db.insert(appointments).values({ memberId: f.fMedoune.id, title: "Pneumologie", appointmentDate: new Date(Date.now() - 2 * 86400000), status: "confirmed" });
    const [rdv] = await db.insert(appointments).values({ memberId: f.fToutou.id, title: "Dentiste", appointmentDate: new Date(Date.now() + 86400000), status: "confirmed" }).returning();
    await db.insert(relayTasks).values({ appointmentId: rdv.id, memberId: f.fToutou.id, familyId: f.family.id, appointmentDate: rdv.appointmentDate });

    const { todo } = (await get(f.papa)).body;
    const types = todo.map((t) => `${t.severity}:${t.type}`);
    expect(types[0]).toBe("alert:vaccine");
    expect(types).toEqual(expect.arrayContaining(["warn:intake", "warn:attendance", "warn:relay", "warn:fiche"]));
    expect(todo.find((t) => t.type === "intake")).toMatchObject({ action: { kind: "intake" }, title: expect.stringContaining("Toutou") });
    expect(todo.find((t) => t.type === "fiche").memberId).toBe(f.fZahra.id);
  });

  it("voyant par membre : rouge, orange ou vert", async () => {
    await db.insert(vaccinations).values({ memberId: f.fToutou.id, vaccineName: "HPV", dateAdministered: "2026-01-01", nextDoseDate: addDays(today(), -5) });
    const cards = (await get(f.papa)).body.members;
    const light = (id) => cards.find((m) => m.id === id).light;
    expect(light(f.fToutou.id)).toBe("red");
    expect(light(f.fZahra.id)).toBe("orange");
    expect(light(f.fMedoune.id)).toBe("green");
  });
});

describe("Traitement mal suivi", () => {
  it("voyant orange « Prises peu suivies » sous 50 %, même sans action du jour", async () => {
    const [t] = await db.insert(treatments).values({ memberId: f.fToutou.id, disease: "Carence en fer", isActive: true }).returning();
    const [med] = await db.insert(treatmentMedications).values({ treatmentId: t.id, name: "Fer", intakeTimes: ["13:00"] }).returning();
    for (const [i, status] of ["missed", "missed", "taken"].entries()) {
      await db.insert(medicationIntakes).values({ medicationId: med.id, memberId: f.fToutou.id, scheduledAt: new Date(Date.now() - (i + 2) * 86400000), status });
    }
    const toutou = (await get(f.papa)).body.members.find((m) => m.id === f.fToutou.id);
    expect(toutou.light).toBe("orange");
    expect(toutou.alerts).toContain("Prises peu suivies : Carence en fer (33 %)");
  });
});

describe("Indicateurs de la famille (30 jours)", () => {
  it("prises suivies et rendez-vous honorés", async () => {
    const [t] = await db.insert(treatments).values({ memberId: f.fMedoune.id, disease: "Asthme", isActive: true }).returning();
    const [med] = await db.insert(treatmentMedications).values({ treatmentId: t.id, name: "Seretide", intakeTimes: ["08:00"] }).returning();
    const statuses = ["taken", "taken", "taken", "not_taken"];
    for (const [i, status] of statuses.entries()) {
      await db.insert(medicationIntakes).values({ medicationId: med.id, memberId: f.fMedoune.id, scheduledAt: new Date(Date.now() - (i + 2) * 86400000), status });
    }
    await db.insert(appointments).values([
      { memberId: f.fMedoune.id, title: "A", appointmentDate: new Date(Date.now() - 3 * 86400000), status: "confirmed", attendance: "attended" },
      { memberId: f.fMedoune.id, title: "B", appointmentDate: new Date(Date.now() - 4 * 86400000), status: "confirmed", attendance: "missed" },
    ]);
    const { indicators, members: cards } = (await get(f.papa)).body;
    expect(indicators.intakes).toEqual({ taken: 3, total: 4, pct: 75 });
    expect(indicators.appointments).toMatchObject({ attended: 1, answered: 2, pct: 50 });
    expect(cards.find((m) => m.id === f.fMedoune.id).treatments[0]).toMatchObject({ disease: "Asthme", adherence: { pct: 75 } });
  });
});
