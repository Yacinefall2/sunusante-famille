import { describe, it, expect, beforeEach } from "vitest";
import {
  resetDatabase,
  createUser,
  createFamily,
  addMembership,
  createMember,
  seedMedicalData,
  as,
} from "./helpers.js";

// Étanchéité entre espaces familiaux sur les routes de liste des données
// médicales : aucune combinaison de paramètres ne doit permettre de lire la
// fiche d'une autre famille.
const ROUTES = ["/api/appointments", "/api/treatments", "/api/vaccinations", "/api/documents"];

let user, myFamily, myMember, otherMember, otherFamily;

beforeEach(async () => {
  await resetDatabase();
  myFamily = await createFamily("Ndiaye");
  otherFamily = await createFamily("Fall");
  user = await createUser("Awa");
  await addMembership(user, myFamily, "parent", { isPrimaryAdmin: true });
  myMember = await createMember(myFamily, "Awa");
  otherMember = await createMember(otherFamily, "Mamadou");
  await seedMedicalData(myMember);
  await seedMedicalData(otherMember);
});

describe.each(ROUTES)("GET %s", (route) => {
  it("refuse ?familyId=<ma famille>&memberId=<fiche d'une autre famille>", async () => {
    const res = await as(user).get(`${route}?familyId=${myFamily.id}&memberId=${otherMember.id}`);
    expect(res.status).toBe(403);
  });

  it("refuse ?memberId=<fiche d'une autre famille>", async () => {
    const res = await as(user).get(`${route}?memberId=${otherMember.id}`);
    expect(res.status).toBe(403);
  });

  it("refuse ?familyId=<autre famille>", async () => {
    const res = await as(user).get(`${route}?familyId=${otherFamily.id}`);
    expect(res.status).toBe(403);
  });

  it("renvoie les données de sa propre fiche", async () => {
    const res = await as(user).get(`${route}?familyId=${myFamily.id}&memberId=${myMember.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].memberId).toBe(myMember.id);
  });

  it("la liste de sa famille ne contient que ses propres fiches", async () => {
    const res = await as(user).get(`${route}?familyId=${myFamily.id}`);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.memberId)).toEqual([myMember.id]);
  });
});
