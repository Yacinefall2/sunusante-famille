import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { members } from "../src/db/schema.js";
import { effectiveRole, ageOn } from "../src/lib/family.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, as } from "./helpers.js";

// Liens de parenté et règles d'âge des comptes (15 et 18 ans).
const yearsAgo = (y, days = 0) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - y);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

describe("Âge et rôle effectif d'un compte", () => {
  it("adolescent avant 18 ans, adulte le jour de ses 18 ans ; les parents restent parents", () => {
    expect(effectiveRole("adult", yearsAgo(17, 364))).toBe("dependent");
    expect(effectiveRole("dependent", yearsAgo(18))).toBe("adult");
    expect(effectiveRole("parent", yearsAgo(16))).toBe("parent");
    expect(effectiveRole("adult", null)).toBe("adult");
    expect(ageOn(yearsAgo(15))).toBe(15);
  });
});

describe("Règles appliquées par l'API", () => {
  let f;
  beforeEach(async () => {
    await resetDatabase();
    const family = await createFamily("Fall");
    const papa = await createUser("Papa");
    const ado = await createUser("Ado");
    const papaM = await addMembership(papa, family, "parent", { isPrimaryAdmin: true });
    const adoM = await addMembership(ado, family, "adult"); // enregistré « adulte »…
    const fPapa = await createMember(family, "Papa");
    const fAdo = await createMember(family, "Ado");
    await db.update(members).set({ dateOfBirth: yearsAgo(16), gender: "M", kinship: "enfant" }).where(eq(members.id, fAdo.id));
    await db.update(members).set({ dateOfBirth: "1970-01-01", gender: "M", kinship: "parent" }).where(eq(members.id, fPapa.id));
    await linkMember(papaM, fPapa);
    await linkMember(adoM, fAdo);
    f = { family, papa, ado, fPapa, fAdo };
  });

  it("un compte de 16 ans est traité en adolescent : lecture seule de sa fiche", async () => {
    const res = await as(f.ado).post("/api/appointments").send({ memberId: f.fAdo.id, title: "X", appointmentDate: "2030-01-01T10:00:00Z" });
    expect(res.status).toBe(403);
    const accounts = (await as(f.papa).get(`/api/family-memberships?familyId=${f.family.id}`)).body;
    expect(accounts.find((a) => a.userId === f.ado.id)).toMatchObject({ role: "dependent", age: 16 });
  });

  it("à 18 ans, le même compte devient adulte sans intervention", async () => {
    await db.update(members).set({ dateOfBirth: yearsAgo(18) }).where(eq(members.id, f.fAdo.id));
    const res = await as(f.ado).post("/api/appointments").send({ memberId: f.fAdo.id, title: "X", appointmentDate: "2030-01-01T10:00:00Z" });
    expect(res.status).toBe(201);
  });

  it("une fiche exige date de naissance, sexe et lien de parenté", async () => {
    const base = { familyId: f.family.id, firstName: "Ibou", lastName: "Fall" };
    expect((await as(f.papa).post("/api/members").send(base)).status).toBe(400);
    expect((await as(f.papa).post("/api/members").send({ ...base, dateOfBirth: yearsAgo(8), gender: "M" })).status).toBe(400);
    const ok = await as(f.papa).post("/api/members").send({ ...base, dateOfBirth: yearsAgo(8), gender: "M", kinship: "enfant" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ kinship: "enfant", gender: "M" });
  });

  it("le lien « Parent » est réservé aux administrateurs, et posé d'office sur leur fiche", async () => {
    const res = await as(f.papa).post("/api/members").send({ familyId: f.family.id, firstName: "X", lastName: "Y", dateOfBirth: "1950-01-01", gender: "M", kinship: "parent" });
    expect(res.status).toBe(400);
    const own = await as(f.papa).put("/api/members").send({ id: f.fPapa.id, firstName: "Papa", lastName: "Fall", dateOfBirth: "1970-01-01", gender: "M", kinship: "oncle_tante" });
    expect(own.status).toBe(200);
    expect(own.body.kinship).toBe("parent");
  });

  it("moins de 15 ans : pas de compte personnel", async () => {
    const enfant = await createUser("Enfant");
    await addMembership(enfant, f.family, "adult");
    const res = await as(enfant).post("/api/members").send({ familyId: f.family.id, firstName: "Enfant", lastName: "Fall", isMine: true, dateOfBirth: yearsAgo(12), gender: "F", kinship: "enfant" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Moins de 15 ans/);

    const petit = await as(f.papa).post("/api/members").send({ familyId: f.family.id, firstName: "Petit", lastName: "Fall", dateOfBirth: yearsAgo(10), gender: "M", kinship: "enfant" });
    const inv = await as(f.papa).post("/api/invitations").send({ familyId: f.family.id, email: "p@t.local", role: "member", linkedMemberId: petit.body.id });
    expect(inv.status).toBe(400);
  });

  it("l'identité (âge, sexe, lien) est visible de tous, le dossier médical non", async () => {
    await db.update(members).set({ allergies: "Arachides" }).where(eq(members.id, f.fPapa.id));
    const list = (await as(f.ado).get(`/api/members?familyId=${f.family.id}`)).body;
    const papa = list.find((m) => m.id === f.fPapa.id);
    expect(papa).toHaveProperty("kinship", "parent");
    expect(papa).not.toHaveProperty("allergies");
  });
});
