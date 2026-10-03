import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db/index.js";
import { documents } from "../src/db/schema.js";
import {
  resetDatabase,
  createUser,
  createFamily,
  addMembership,
  createMember,
  linkMember,
  grantRole,
  as,
} from "./helpers.js";

// Foyer : Awa (A1), Moussa (A2), Fatou (A3, titulaire de sa fiche), Omar
// (A3, gestionnaire de la fiche de Fatou), grand-père (fiche sans compte).
let f;

beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Ndiaye");
  const [awa, moussa, fatou, omar] = await Promise.all(["Awa", "Moussa", "Fatou", "Omar"].map((n) => createUser(n)));
  const awaM = await addMembership(awa, family, "parent", { isPrimaryAdmin: true });
  await addMembership(moussa, family, "parent");
  const fatouM = await addMembership(fatou, family, "adult");
  await addMembership(omar, family, "adult");
  const fiches = {
    awa: await createMember(family, "Awa"),
    fatou: await createMember(family, "Fatou"),
    grandPere: await createMember(family, "Grand-père"),
  };
  await linkMember(awaM, fiches.awa);
  await linkMember(fatouM, fiches.fatou);
  await grantRole(fiches.fatou, omar, "gestionnaire");
  f = { family, awa, moussa, fatou, omar, fiches };
});

const upload = (user, member, extra = {}) => {
  let req = as(user).post("/api/documents").field("memberId", String(member.id)).field("title", "Ordonnance").field("documentType", "ordonnance");
  for (const [k, v] of Object.entries(extra)) req = req.field(k, String(v));
  return req;
};
const docTitles = async (user) =>
  (await as(user).get(`/api/documents?familyId=${f.family.id}`)).body.map((d) => d.title).sort();

describe("Documents confidentiels (UC-16, §10)", () => {
  it("seul le titulaire peut marquer un document confidentiel", async () => {
    expect((await upload(f.fatou, f.fiches.fatou, { isConfidential: true })).status).toBe(201);
    expect((await upload(f.omar, f.fiches.fatou, { isConfidential: true })).status).toBe(403);
    expect((await upload(f.awa, f.fiches.grandPere, { isConfidential: true })).status).toBe(403);
  });

  it("n'est visible que du titulaire et de A1", async () => {
    await upload(f.fatou, f.fiches.fatou, { isConfidential: true });
    await db.insert(documents).values({ memberId: f.fiches.fatou.id, title: "Public", documentType: "autre" });
    const secret = (await as(f.fatou).get(`/api/documents?familyId=${f.family.id}`)).body.find((d) => d.isConfidential);
    expect(secret).toBeDefined();

    expect((await as(f.awa).get(`/api/documents?familyId=${f.family.id}`)).body.some((d) => d.id === secret.id)).toBe(true);
    for (const other of [f.moussa, f.omar]) {
      const list = (await as(other).get(`/api/documents?familyId=${f.family.id}`)).body;
      expect(list.some((d) => d.id === secret.id)).toBe(false);
      expect(list.some((d) => d.title === "Public")).toBe(true);
      expect((await as(other).delete(`/api/documents?id=${secret.id}`)).status).toBe(404);
    }
  });

  it("le titulaire peut retirer ou poser la confidentialité après coup", async () => {
    const doc = (await upload(f.omar, f.fiches.fatou)).body;
    const body = { id: doc.id, title: doc.title, documentType: doc.documentType, isConfidential: true };
    expect((await as(f.omar).put("/api/documents").send(body)).status).toBe(403);
    expect((await as(f.fatou).put("/api/documents").send(body)).status).toBe(200);
    expect(await docTitles(f.omar)).toEqual([]);
  });
});

describe("Suppression d'un document (UC-15)", () => {
  it("enregistre l'auteur et le renvoie à l'interface", async () => {
    const doc = (await upload(f.omar, f.fiches.fatou)).body;
    expect(doc).toMatchObject({ uploadedByUserId: f.omar.id, uploadedByName: "Omar", canDelete: true });
  });

  it("le gestionnaire supprime ce qu'il a ajouté, pas ce qu'a ajouté le titulaire", async () => {
    const byOmar = (await upload(f.omar, f.fiches.fatou)).body;
    const byFatou = (await upload(f.fatou, f.fiches.fatou)).body;
    expect((await as(f.omar).delete(`/api/documents?id=${byFatou.id}`)).status).toBe(403);
    expect((await as(f.omar).delete(`/api/documents?id=${byOmar.id}`)).status).toBe(200);
  });

  it("le titulaire supprime aussi ce qu'a ajouté son gestionnaire ; un administrateur non", async () => {
    const byOmar = (await upload(f.omar, f.fiches.fatou)).body;
    expect((await as(f.awa).delete(`/api/documents?id=${byOmar.id}`)).status).toBe(403);
    expect((await as(f.fatou).delete(`/api/documents?id=${byOmar.id}`)).status).toBe(200);
  });

  it("documents anciens sans auteur : titulaire, ou administrateur si la fiche n'a pas de compte", async () => {
    const [onFatou] = await db.insert(documents).values({ memberId: f.fiches.fatou.id, title: "Ancien", documentType: "autre" }).returning();
    const [onGrandPere] = await db.insert(documents).values({ memberId: f.fiches.grandPere.id, title: "Ancien", documentType: "autre" }).returning();
    expect((await as(f.awa).delete(`/api/documents?id=${onFatou.id}`)).status).toBe(403);
    expect((await as(f.fatou).delete(`/api/documents?id=${onFatou.id}`)).status).toBe(200);
    expect((await as(f.awa).delete(`/api/documents?id=${onGrandPere.id}`)).status).toBe(200);
  });
});

describe("Fiche : coordonnées, médecin traitant, contact d'urgence (M2)", () => {
  it("enregistre les champs et les masque à qui ne lit pas le dossier", async () => {
    const res = await as(f.fatou).put("/api/members").send({
      id: f.fiches.fatou.id,
      firstName: "Fatou",
      lastName: "Diop",
      phone: " +221 77 000 00 00 ",
      doctorName: "Dr Sarr",
      doctorPhone: "+221 33 000 00 00",
      emergencyContactName: "Awa Ndiaye",
      emergencyContactRelation: "Sœur",
      emergencyContactPhone: "+221 76 000 00 00",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ phone: "+221 77 000 00 00", doctorName: "Dr Sarr", emergencyContactRelation: "Sœur" });

    const outsider = await createUser("Externe");
    await addMembership(outsider, f.family, "adult");
    const seen = (await as(outsider).get(`/api/members?familyId=${f.family.id}`)).body.find((m) => m.id === f.fiches.fatou.id);
    for (const field of ["phone", "doctorName", "doctorPhone", "emergencyContactName", "emergencyContactPhone"]) {
      expect(seen).not.toHaveProperty(field);
    }
  });
});

describe("Horaires de prise (M4)", () => {
  it("garde des heures HH:MM valides, sans doublon, triées", async () => {
    const res = await as(f.fatou).post("/api/treatments").send({
      memberId: f.fiches.fatou.id,
      disease: "Hypertension",
      medications: [{ name: "Amlodipine", intakeTimes: ["20:00", "08:00", "25:00", "8h", "08:00"] }],
    });
    expect(res.status).toBe(201);
    expect(res.body.medications[0].intakeTimes).toEqual(["08:00", "20:00"]);
  });
});

describe("Rendez-vous : statut et présence (M3, UC-18)", () => {
  const future = "2099-01-01T10:00:00Z";
  const past = "2020-01-01T10:00:00Z";
  const create = (body) => as(f.fatou).post("/api/appointments").send({ memberId: f.fiches.fatou.id, title: "Contrôle", ...body });

  it("est « en attente » par défaut et refuse un statut inconnu", async () => {
    expect((await create({ appointmentDate: future })).body.status).toBe("pending");
    expect((await create({ appointmentDate: future, status: "upcoming" })).status).toBe(400);
  });

  it("la présence ne se renseigne qu'une fois le rendez-vous passé et non annulé", async () => {
    const upcoming = (await create({ appointmentDate: future, status: "confirmed" })).body;
    expect((await as(f.fatou).put("/api/appointments/attendance").send({ id: upcoming.id, attendance: "attended" })).status).toBe(400);

    const done = (await create({ appointmentDate: past, status: "confirmed" })).body;
    const ok = await as(f.fatou).put("/api/appointments/attendance").send({ id: done.id, attendance: "missed" });
    expect(ok.status).toBe(200);
    expect(ok.body.attendance).toBe("missed");

    const cancelled = (await create({ appointmentDate: past, status: "cancelled" })).body;
    expect((await as(f.fatou).put("/api/appointments/attendance").send({ id: cancelled.id, attendance: "attended" })).status).toBe(400);
  });

  it("la présence est effacée si le rendez-vous est déplacé dans le futur", async () => {
    const done = (await create({ appointmentDate: past, status: "confirmed", attendance: "attended" })).body;
    expect(done.attendance).toBe("attended");
    const moved = await as(f.fatou).put("/api/appointments").send({ id: done.id, title: "Contrôle", appointmentDate: future });
    expect(moved.status).toBe(200);
    expect(moved.body.attendance).toBeNull();
  });

  it("un compte sans accès complet ne renseigne pas la présence", async () => {
    const done = (await create({ appointmentDate: past, status: "confirmed" })).body;
    expect((await as(f.moussa).put("/api/appointments/attendance").send({ id: done.id, attendance: "attended" })).status).toBe(200);
    const outsider = await createUser("Externe");
    await addMembership(outsider, f.family, "adult");
    expect((await as(outsider).put("/api/appointments/attendance").send({ id: done.id, attendance: "attended" })).status).toBe(403);
  });
});
