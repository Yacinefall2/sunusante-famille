import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { members, treatments } from "../src/db/schema.js";
import { isIsoDate, isTime, parseDateTime, parseId } from "../src/lib/validation.js";
import { zonedTime } from "../src/lib/time.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, as } from "./helpers.js";

describe("lib/validation.js", () => {
  it("identifiants : entiers positifs dans les limites de la base", () => {
    expect(parseId("12")).toBe(12);
    expect(parseId(7)).toBe(7);
    for (const bad of ["abc", "1abc", "0", "-3", "1.5", 1.5, "99999999999", "", null, undefined, {}]) expect(parseId(bad)).toBeNull();
  });

  it("dates strictes (aller-retour) et heures HH:MM", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026-1-1", "2026-01-01T00:00"]) expect(isIsoDate(bad)).toBe(false);
    expect(isTime("00:00") && isTime("23:59")).toBe(true);
    for (const bad of ["24:00", "8:00", "12:60", "12h00"]) expect(isTime(bad)).toBe(false);
  });

  it("heure d'un rendez-vous sans fuseau : lue dans le fuseau de l'application (point 14)", () => {
    // Niamey (UTC+1) : 10:00 locale = 09:00 UTC.
    expect(parseDateTime("2026-11-10T10:00", "Africa/Niamey").toISOString()).toBe("2026-11-10T09:00:00.000Z");
    expect(parseDateTime("2026-11-10T10:00:30", "Africa/Niamey").toISOString()).toBe("2026-11-10T09:00:30.000Z");
    // Avec un fuseau explicite, la chaîne est prise telle quelle.
    expect(parseDateTime("2026-11-10T10:00:00Z", "Africa/Niamey").toISOString()).toBe("2026-11-10T10:00:00.000Z");
    expect(parseDateTime("2026-11-10T10:00:00+02:00", "Africa/Niamey").toISOString()).toBe("2026-11-10T08:00:00.000Z");
    for (const bad of ["2026-02-30T10:00", "2026-11-10T24:00", "demain", "2026-11-10", 42]) expect(parseDateTime(bad)).toBeNull();
  });
});

describe("Validation par l'API (point 15)", () => {
  let f;
  beforeEach(async () => {
    await resetDatabase();
    const family = await createFamily("Ka");
    const awa = await createUser("Awa");
    const awaM = await addMembership(awa, family, "parent", { isPrimaryAdmin: true });
    const fiche = await createMember(family, "Awa");
    await linkMember(awaM, fiche);
    f = { family, awa, fiche };
  });

  it("identifiant mal formé ou trop grand : 400, jamais 500", async () => {
    const a = as(f.awa);
    const checks = [
      await a.post("/api/notifications/abc/read"),
      await a.post("/api/intakes/abc/respond").send({ status: "taken" }),
      await a.post("/api/village/tasks/99999999999/notified"),
      await a.post("/api/vaccinations/99999999999/booster-done").send({}),
      await a.put("/api/appointments").send({ id: "99999999999", title: "X" }),
      await a.put("/api/treatments").send({ id: "abc", disease: "X", medications: [{ name: "Y" }] }),
      await a.delete("/api/vaccinations?id=abc"),
      await a.get(`/api/members?familyId=99999999999`),
      await a.post("/api/appointments").send({ memberId: "1e3", title: "X", appointmentDate: "2030-01-01T10:00" }),
    ];
    expect(checks.map((r) => r.status)).toEqual(checks.map(() => 400));
  });

  it("dates strictes et cohérentes", async () => {
    const a = as(f.awa);
    const fiche = { familyId: f.family.id, firstName: "Ibou", lastName: "Ka", gender: "M", kinship: "enfant" };
    expect((await a.post("/api/members").send({ ...fiche, dateOfBirth: "2020-02-30" })).status).toBe(400);
    expect((await a.post("/api/members").send({ ...fiche, dateOfBirth: "2020-02-29" })).status).toBe(201);

    const med = [{ name: "Amoxicilline" }];
    const t = (body) => a.post("/api/treatments").send({ memberId: f.fiche.id, disease: "Angine", medications: med, ...body });
    expect((await t({ startDate: "2026-02-30" })).status).toBe(400);
    expect((await t({ startDate: "2026-03-10", endDate: "2026-03-01" })).status).toBe(400);
    expect((await t({ startDate: "2026-03-01", endDate: "2026-03-10" })).status).toBe(201);

    const v = (body) => a.post("/api/vaccinations").send({ memberId: f.fiche.id, vaccineName: "Fièvre jaune", ...body });
    expect((await v({ dateAdministered: "2099-01-01" })).status).toBe(400);
    expect((await v({ dateAdministered: "2025-01-01", nextDoseDate: "2024-01-01" })).status).toBe(400);
    expect((await v({ dateAdministered: "2025-01-31", nextDoseDate: "2026-02-31" })).status).toBe(400);
    const ok = await v({ dateAdministered: "2025-01-01", nextDoseDate: "2035-01-01" });
    expect(ok.status).toBe(201);

    expect((await a.put("/api/vaccinations").send({ id: ok.body.id, vaccineName: "  " })).status).toBe(400);
    expect((await a.put("/api/vaccinations").send({ id: ok.body.id, dateAdministered: "2099-01-01" })).status).toBe(400);
    const kept = await a.put("/api/vaccinations").send({ id: ok.body.id, lotNumber: "L-42" });
    expect(kept.body).toMatchObject({ vaccineName: "Fièvre jaune", nextDoseDate: "2035-01-01", lotNumber: "L-42" });
  });

  it("longueurs maximales (varchar du schéma)", async () => {
    const a = as(f.awa);
    const long = (n) => "x".repeat(n);
    expect((await a.post("/api/members").send({ familyId: f.family.id, firstName: long(101), lastName: "Ka", dateOfBirth: "1990-01-01", gender: "M", kinship: "cousin" })).status).toBe(400);
    expect((await a.post("/api/appointments").send({ memberId: f.fiche.id, title: long(256), appointmentDate: "2030-01-01T10:00" })).status).toBe(400);
    expect((await a.post("/api/appointments").send({ memberId: f.fiche.id, title: "Contrôle", location: long(256), appointmentDate: "2030-01-01T10:00" })).status).toBe(400);
    const other = await createUser("Autre");
    expect((await as(other).post("/api/families").send({ name: long(256) })).status).toBe(400);
  });

  it("rendez-vous : heure locale sans fuseau, heure invalide refusée, champs absents conservés", async () => {
    const a = as(f.awa);
    const created = await a.post("/api/appointments").send({ memberId: f.fiche.id, title: "Contrôle", location: "Dakar", notes: "À jeun", appointmentDate: "2030-01-01T10:00" });
    expect(created.status).toBe(201);
    expect(new Date(created.body.appointmentDate).toISOString()).toBe(zonedTime("2030-01-01", "10:00").toISOString());
    expect((await a.post("/api/appointments").send({ memberId: f.fiche.id, title: "X", appointmentDate: "2030-01-01T25:00" })).status).toBe(400);

    const updated = await a.put("/api/appointments").send({ id: created.body.id, status: "confirmed" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ title: "Contrôle", location: "Dakar", notes: "À jeun", status: "confirmed" });
    expect((await a.put("/api/appointments").send({ id: created.body.id, title: "" })).status).toBe(400);
  });

  it("un traitement arrêté n'est pas réactivé si isActive est absent", async () => {
    const a = as(f.awa);
    const created = await a.post("/api/treatments").send({ memberId: f.fiche.id, disease: "Angine", isActive: false, medications: [{ name: "Amoxicilline" }] });
    const res = await a.put("/api/treatments").send({ id: created.body.id, disease: "Angine", medications: created.body.medications });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(treatments).where(eq(treatments.id, created.body.id));
    expect(row.isActive).toBe(false);
  });

  it("date de naissance du futur refusée", async () => {
    const res = await as(f.awa).post("/api/members").send({ familyId: f.family.id, firstName: "Futur", lastName: "Ka", dateOfBirth: "2099-01-01", gender: "M", kinship: "enfant" });
    expect(res.status).toBe(400);
    expect(await db.select().from(members).where(eq(members.firstName, "Futur"))).toHaveLength(0);
  });
});
