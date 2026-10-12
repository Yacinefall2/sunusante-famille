import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { documentRoles, familyMemberships, members, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { resetDatabase, createUser, createFamilyWithAdmins, addMembership, createMember, linkMember, grantRole, as } from "./helpers.js";

// UC-06 : retirer un membre — ses dossiers gérés sont réaffectés au préalable.
// Et suppression de son propre compte : confiés automatiquement à A1.

const PASSWORD = "Mon-mdp-123";
const managersOf = async (fiche) =>
  (
    await db
      .select({ userId: documentRoles.userId })
      .from(documentRoles)
      .where(and(eq(documentRoles.memberId, fiche.id), eq(documentRoles.role, "gestionnaire")))
  ).map((r) => r.userId);
const journal = async (user, familyId) => (await as(user).get(`/api/activity?familyId=${familyId}&category=roles`)).body.entries.map((e) => e.text);

let f;
beforeEach(async () => {
  await resetDatabase();
  const base = await createFamilyWithAdmins("Ba");
  for (const [m, name] of [[base.a1Membership, "A1"], [base.a2Membership, "A2"], [base.adultMembership, "Adulte"]]) {
    await linkMember(m, await createMember(base.family, name));
  }
  // Adolescente (16 ans) : jamais destinataire d'une réaffectation.
  const teen = await createUser("Ado");
  const teenM = await addMembership(teen, base.family, "adult");
  const teenFiche = await createMember(base.family, "Ado");
  const sixteen = new Date();
  sixteen.setUTCFullYear(sixteen.getUTCFullYear() - 16);
  await db.update(members).set({ dateOfBirth: sixteen.toISOString().slice(0, 10) }).where(eq(members.id, teenFiche.id));
  await linkMember(teenM, teenFiche);
  // Papy : géré par l'adulte seul. Mamie : gérée par l'adulte ET par A2.
  const papy = await createMember(base.family, "Papy");
  const mamie = await createMember(base.family, "Mamie");
  await grantRole(papy, base.adult, "gestionnaire");
  await grantRole(mamie, base.adult, "gestionnaire");
  await grantRole(mamie, base.a2, "gestionnaire");
  f = { ...base, teen, papy, mamie };
});

const removeAdult = (body) => {
  const req = as(f.a1).delete(`/api/family-memberships?id=${f.adultMembership.id}`);
  return body ? req.send(body) : req;
};

describe("Retrait d'un compte avec réaffectation (UC-06)", () => {
  it("liste des dossiers à confier et des destinataires possibles", async () => {
    const res = await as(f.a1).get(`/api/family-memberships/${f.adultMembership.id}/managed-fiches`);
    expect(res.status).toBe(200);
    // Mamie a encore un autre gestionnaire : seule la fiche de Papy est à confier.
    expect(res.body.fiches).toEqual([{ id: f.papy.id, firstName: "Papy", lastName: "Test" }]);
    expect(res.body.candidates.map((c) => c.userId).sort()).toEqual([f.a1.id, f.a2.id].sort());
    expect(res.body.defaultUserId).toBe(f.a1.id);
    // Réservé aux parents.
    expect((await as(f.adult).get(`/api/family-memberships/${f.a2Membership.id}/managed-fiches`)).status).toBe(403);
  });

  it("retrait refusé (409) tant que les dossiers dont il est seul gestionnaire ne sont pas confiés", async () => {
    const res = await removeAdult();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REASSIGNMENT_REQUIRED");
    expect(res.body.fiches.map((x) => x.id)).toEqual([f.papy.id]);
    // Rien n'a bougé.
    expect(await db.select().from(familyMemberships).where(eq(familyMemberships.id, f.adultMembership.id))).toHaveLength(1);
    expect(await managersOf(f.papy)).toEqual([f.adult.id]);
  });

  it("destinataire invalide refusé : adolescent, compte retiré, compte d'une autre famille", async () => {
    const outsider = await createUser("Étranger");
    for (const userId of [f.teen.id, f.adult.id, outsider.id]) {
      const res = await removeAdult({ reassignments: [{ memberId: f.papy.id, userId }] });
      expect(res.status).toBe(400);
    }
    expect((await removeAdult({ reassignments: [{ memberId: "x", userId: f.a2.id }] })).status).toBe(400);
    expect(await managersOf(f.papy)).toEqual([f.adult.id]);
  });

  it("réaffectation valide puis retrait : nouveau gestionnaire, compte retiré, journal", async () => {
    const res = await removeAdult({ reassignments: [{ memberId: f.papy.id, userId: f.a2.id }] });
    expect(res.status).toBe(200);
    expect(await managersOf(f.papy)).toEqual([f.a2.id]);
    expect(await managersOf(f.mamie)).toEqual([f.a2.id]);
    expect(await db.select().from(familyMemberships).where(eq(familyMemberships.id, f.adultMembership.id))).toHaveLength(0);
    // Sa propre fiche est archivée, comme avant.
    const [own] = await db.select().from(members).where(eq(members.id, f.adultMembership.linkedMemberId));
    expect(own.archivedAt).not.toBeNull();
    expect(await journal(f.a1, f.family.id)).toContain(
      `${f.a1.name} a confié la gestion du dossier de Papy Test à ${f.a2.name} lors du retrait de ${f.adult.name}`
    );
  });

  it("sans dossier à confier, le retrait se fait directement", async () => {
    await db.delete(documentRoles).where(eq(documentRoles.memberId, f.papy.id));
    expect((await removeAdult()).status).toBe(200);
  });
});

describe("Suppression de son propre compte", () => {
  it("les dossiers dont il était le seul gestionnaire sont confiés à A1, et c'est journalisé", async () => {
    await db.update(users).set({ passwordHash: await hashPassword(PASSWORD) }).where(eq(users.id, f.adult.id));
    const res = await as(f.adult).delete("/api/account").send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await managersOf(f.papy)).toEqual([f.a1.id]);
    // Mamie garde A2 ; A1 n'y est pas ajouté.
    expect(await managersOf(f.mamie)).toEqual([f.a2.id]);
    expect(await journal(f.a1, f.family.id)).toContain(
      `La gestion du dossier de Papy Test a été confiée à ${f.a1.name} (administrateur familial) : ${f.adult.name} (compte supprimé), qui en était le seul gestionnaire, a supprimé son compte`
    );
  });
});
