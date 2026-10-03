import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db/index.js";
import { documents } from "../src/db/schema.js";
import { UPLOAD_DIR_PATH } from "../src/middleware/upload.js";
import {
  resetDatabase,
  createUser,
  createFamily,
  addMembership,
  createMember,
  linkMember,
  grantRole,
  seedMedicalData,
  as,
} from "./helpers.js";

// Foyer de référence (personas de la spécification) :
//   Awa    — A1, titulaire de sa fiche
//   Moussa — A2, titulaire de sa fiche
//   Fatou  — A3, titulaire de sa fiche, lectrice invitée du dossier d'Ibou,
//            relais pour le dossier du grand-père
//   Khady  — adolescente (dependent), reliée à sa fiche
//   Ibou (mineur géré) et Grand-père (non connecté) — fiches sans compte
let f;

beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Ndiaye");
  const awa = await createUser("Awa");
  const moussa = await createUser("Moussa");
  const fatou = await createUser("Fatou");
  const khady = await createUser("Khady");
  const awaM = await addMembership(awa, family, "parent", { isPrimaryAdmin: true });
  const moussaM = await addMembership(moussa, family, "parent");
  const fatouM = await addMembership(fatou, family, "adult");
  const khadyM = await addMembership(khady, family, "dependent");

  const fiches = {
    awa: await createMember(family, "Awa"),
    moussa: await createMember(family, "Moussa"),
    fatou: await createMember(family, "Fatou"),
    khady: await createMember(family, "Khady"),
    ibou: await createMember(family, "Ibou"),
    grandPere: await createMember(family, "Grand-père"),
  };
  await linkMember(awaM, fiches.awa);
  await linkMember(moussaM, fiches.moussa);
  await linkMember(fatouM, fiches.fatou);
  await linkMember(khadyM, fiches.khady);
  await grantRole(fiches.ibou, fatou, "lecteur_invite");
  await grantRole(fiches.grandPere, fatou, "relais");
  for (const m of Object.values(fiches)) await seedMedicalData(m);

  f = { family, awa, moussa, fatou, khady, fiches };
});

const memberIdsOf = (res) => [...new Set(res.body.map((r) => r.memberId))].sort((a, b) => a - b);
const ids = (...members) => members.map((m) => m.id).sort((a, b) => a - b);
const newAppointment = (member) => ({ memberId: member.id, title: "Contrôle", appointmentDate: "2030-01-01T10:00:00Z" });

describe("Administrateurs (A1 / A2) — règle réciproque §10", () => {
  it("A1 lit tout le foyer sauf la fiche de A2", async () => {
    const res = await as(f.awa).get(`/api/documents?familyId=${f.family.id}`);
    expect(res.status).toBe(200);
    const { awa, fatou, khady, ibou, grandPere } = f.fiches;
    expect(memberIdsOf(res)).toEqual(ids(awa, fatou, khady, ibou, grandPere));
  });

  it("A1 ne lit ni ne modifie la fiche de A2", async () => {
    expect((await as(f.awa).get(`/api/treatments?memberId=${f.fiches.moussa.id}`)).status).toBe(403);
    expect((await as(f.awa).post("/api/appointments").send(newAppointment(f.fiches.moussa))).status).toBe(403);
    expect((await as(f.awa).put("/api/members").send({ id: f.fiches.moussa.id, firstName: "X", lastName: "Y" })).status).toBe(403);
  });

  it("A2 ne lit pas la fiche de A1", async () => {
    expect((await as(f.moussa).get(`/api/vaccinations?memberId=${f.fiches.awa.id}`)).status).toBe(403);
  });

  it("A2 peut déléguer la lecture de son dossier à A1, puis la révoquer (UC-26)", async () => {
    const grant = await as(f.moussa)
      .post("/api/document-roles")
      .send({ memberId: f.fiches.moussa.id, userId: f.awa.id, role: "lecteur_invite" });
    expect(grant.status).toBe(201);
    expect((await as(f.awa).get(`/api/treatments?memberId=${f.fiches.moussa.id}`)).status).toBe(200);
    expect((await as(f.awa).post("/api/appointments").send(newAppointment(f.fiches.moussa))).status).toBe(403);

    expect((await as(f.moussa).delete(`/api/document-roles?id=${grant.body.id}`)).status).toBe(200);
    expect((await as(f.awa).get(`/api/treatments?memberId=${f.fiches.moussa.id}`)).status).toBe(403);
  });
});

describe("Membre (A3)", () => {
  it("ne lit que sa fiche et celles qui lui sont accordées", async () => {
    const res = await as(f.fatou).get(`/api/documents?familyId=${f.family.id}`);
    expect(res.status).toBe(200);
    expect(memberIdsOf(res)).toEqual(ids(f.fiches.fatou, f.fiches.ibou));
    expect((await as(f.fatou).get(`/api/documents?memberId=${f.fiches.awa.id}`)).status).toBe(403);
  });

  it("écrit dans son dossier, mais pas dans un dossier en lecture seule", async () => {
    expect((await as(f.fatou).post("/api/appointments").send(newAppointment(f.fiches.fatou))).status).toBe(201);
    expect((await as(f.fatou).post("/api/appointments").send(newAppointment(f.fiches.ibou))).status).toBe(403);
    expect((await as(f.fatou).put("/api/members").send({ id: f.fiches.ibou.id, firstName: "X", lastName: "Y" })).status).toBe(403);
  });

  it("ne gère pas les accès d'un dossier qui n'est pas le sien", async () => {
    const res = await as(f.fatou)
      .post("/api/document-roles")
      .send({ memberId: f.fiches.ibou.id, userId: f.khady.id, role: "relais" });
    expect(res.status).toBe(403);
  });

  it("le tableau de bord se limite aux dossiers lisibles", async () => {
    const res = await as(f.fatou).get(`/api/dashboard?familyId=${f.family.id}`);
    expect(res.status).toBe(200);
    expect(res.body.members.map((m) => m.id).sort((a, b) => a - b)).toEqual(ids(f.fiches.fatou, f.fiches.ibou));
  });
});

describe("Relais (R3) — date, heure et lieu uniquement (§4.4)", () => {
  it("voit les rendez-vous du proche sans titre ni praticien", async () => {
    const res = await as(f.fatou).get(`/api/appointments?memberId=${f.fiches.grandPere.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ restricted: true, memberId: f.fiches.grandPere.id });
    expect(res.body[0]).not.toHaveProperty("title");
    expect(res.body[0]).not.toHaveProperty("doctorName");
    expect(res.body[0]).not.toHaveProperty("notes");
  });

  it("n'a aucun accès au reste du dossier", async () => {
    for (const route of ["/api/treatments", "/api/vaccinations", "/api/documents"]) {
      expect((await as(f.fatou).get(`${route}?memberId=${f.fiches.grandPere.id}`)).status).toBe(403);
    }
  });
});

describe("Adolescent (dependent)", () => {
  it("lit sa fiche, sans rien pouvoir modifier", async () => {
    expect((await as(f.khady).get(`/api/treatments?memberId=${f.fiches.khady.id}`)).status).toBe(200);
    expect((await as(f.khady).post("/api/appointments").send(newAppointment(f.fiches.khady))).status).toBe(403);
  });

  it("ne lit aucune autre fiche", async () => {
    const res = await as(f.khady).get(`/api/documents?familyId=${f.family.id}`);
    expect(memberIdsOf(res)).toEqual(ids(f.fiches.khady));
  });
});

describe("Liste des membres — identité pour tous, dossier médical selon les droits", () => {
  it("renvoie tout le foyer, sans champ médical pour les fiches non lisibles", async () => {
    const res = await as(f.fatou).get(`/api/members?familyId=${f.family.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
    const byId = Object.fromEntries(res.body.map((m) => [m.id, m]));

    expect(byId[f.fiches.fatou.id]).toMatchObject({ access: "full", isMine: true, hasAccount: true });
    expect(byId[f.fiches.fatou.id]).toHaveProperty("allergies");
    expect(byId[f.fiches.ibou.id]).toMatchObject({ access: "read", isMine: false });
    expect(byId[f.fiches.grandPere.id]).toMatchObject({ access: "relay" });
    expect(byId[f.fiches.awa.id]).toMatchObject({ access: null, firstName: "Awa" });
    for (const hidden of [byId[f.fiches.awa.id], byId[f.fiches.grandPere.id]]) {
      for (const field of ["allergies", "bloodType", "notes", "dateOfBirth"]) expect(hidden).not.toHaveProperty(field);
    }
  });
});

describe("Fichiers téléversés", () => {
  const filename = `test-${process.pid}.txt`;
  afterEach(() => fs.rmSync(path.join(UPLOAD_DIR_PATH, filename), { force: true }));

  it("ne sont servis qu'aux comptes qui lisent le dossier", async () => {
    fs.writeFileSync(path.join(UPLOAD_DIR_PATH, filename), "ordonnance");
    await db.insert(documents).values({
      memberId: f.fiches.awa.id,
      title: "Ordonnance",
      documentType: "ordonnance",
      fileUrl: `/uploads/${filename}`,
    });

    expect((await as(f.fatou).get(`/uploads/${filename}`)).status).toBe(403);
    const ok = await as(f.awa).get(`/uploads/${filename}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("ordonnance");
  });
});

describe("Ma fiche (Titulaire)", () => {
  it("un compte sans fiche crée la sienne", async () => {
    const omar = await createUser("Omar");
    await addMembership(omar, f.family, "adult");
    const res = await as(omar).post("/api/members").send({ familyId: f.family.id, firstName: "Omar", lastName: "Ndiaye", isMine: true });
    expect(res.status).toBe(201);
    const list = await as(omar).get(`/api/members?familyId=${f.family.id}`);
    expect(list.body.find((m) => m.id === res.body.id)).toMatchObject({ isMine: true, access: "full" });
  });

  it("peut désigner comme sienne une fiche qu'il gère, pas une autre", async () => {
    const omar = await createUser("Omar");
    await addMembership(omar, f.family, "adult");
    const created = await as(omar).post("/api/members").send({ familyId: f.family.id, firstName: "Omar", lastName: "N" });
    expect((await as(omar).post("/api/members/claim").send({ id: f.fiches.ibou.id })).status).toBe(403);
    expect((await as(omar).post("/api/members/claim").send({ id: created.body.id })).status).toBe(200);
    expect((await as(omar).post("/api/members/claim").send({ id: created.body.id })).status).toBe(409);
  });

  it("la fiche d'un compte de la famille ne peut pas être supprimée", async () => {
    expect((await as(f.awa).delete(`/api/members?id=${f.fiches.fatou.id}`)).status).toBe(409);
    expect((await as(f.awa).delete(`/api/members?id=${f.fiches.ibou.id}`)).status).toBe(200);
  });

  it("un administrateur ne peut pas se relier lui-même à une fiche", async () => {
    const res = await as(f.awa)
      .put("/api/family-memberships")
      .send({ id: (await as(f.awa).get(`/api/family-memberships?familyId=${f.family.id}`)).body.find((m) => m.userId === f.awa.id).id, role: "parent", linkedMemberId: f.fiches.ibou.id });
    expect(res.status).toBe(403);
  });
});
