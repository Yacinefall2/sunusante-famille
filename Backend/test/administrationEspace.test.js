import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { documentRoles, familyMemberships, pendingInvitations } from "../src/db/schema.js";
import {
  resetDatabase,
  createUser,
  createFamily,
  addMembership,
  createMember,
  createFamilyWithAdmins,
  as,
} from "./helpers.js";

beforeEach(resetDatabase);

describe("Retrait d'un membre (UC-06)", () => {
  it("A2 ne peut pas retirer A1", async () => {
    const { a2, a1Membership } = await createFamilyWithAdmins();
    const res = await as(a2).delete(`/api/family-memberships?id=${a1Membership.id}`);
    expect(res.status).toBe(403);
    const [still] = await db.select().from(familyMemberships).where(eq(familyMemberships.id, a1Membership.id));
    expect(still).toBeDefined();
  });

  it("A1 peut retirer A2, et ses rôles de dossier dans la famille disparaissent", async () => {
    const { family, a1, a2, a2Membership } = await createFamilyWithAdmins();
    const member = await createMember(family);
    await db.insert(documentRoles).values({ memberId: member.id, userId: a2.id, role: "gestionnaire" });

    const res = await as(a1).delete(`/api/family-memberships?id=${a2Membership.id}`);
    expect(res.status).toBe(200);
    const roles = await db.select().from(documentRoles).where(eq(documentRoles.userId, a2.id));
    expect(roles).toHaveLength(0);
  });

  it("un membre adulte ne peut retirer personne", async () => {
    const { adult, a2Membership } = await createFamilyWithAdmins();
    const res = await as(adult).delete(`/api/family-memberships?id=${a2Membership.id}`);
    expect(res.status).toBe(403);
  });
});

describe("Changement de rôle d'espace (UC-05)", () => {
  it("A2 ne peut pas nommer un co-administrateur", async () => {
    const family = await createFamily();
    const a1 = await createUser("A1");
    const a2 = await createUser("A2");
    const adult = await createUser("Adulte");
    await addMembership(a1, family, "parent", { isPrimaryAdmin: true });
    await addMembership(a2, family, "parent");
    const adultMembership = await addMembership(adult, family, "adult");

    const res = await as(a2).put("/api/family-memberships").send({ id: adultMembership.id, role: "parent" });
    expect(res.status).toBe(403);
  });

  it("A1 peut nommer un co-administrateur", async () => {
    const family = await createFamily();
    const a1 = await createUser("A1");
    const adult = await createUser("Adulte");
    await addMembership(a1, family, "parent", { isPrimaryAdmin: true });
    const adultMembership = await addMembership(adult, family, "adult");

    const res = await as(a1).put("/api/family-memberships").send({ id: adultMembership.id, role: "parent" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("parent");
  });

  it("A1 ne peut pas quitter son propre rôle d'administrateur", async () => {
    const { a1, a1Membership } = await createFamilyWithAdmins();
    const res = await as(a1).put("/api/family-memberships").send({ id: a1Membership.id, role: "adult" });
    expect(res.status).toBe(403);
  });

  it("A2 ne peut pas modifier le rôle de A1", async () => {
    const { a2, a1Membership } = await createFamilyWithAdmins();
    const res = await as(a2).put("/api/family-memberships").send({ id: a1Membership.id, role: "adult" });
    expect(res.status).toBe(403);
  });
});

describe("Invitations", () => {
  it("A2 ne peut pas inviter un co-administrateur", async () => {
    const family = await createFamily();
    const a1 = await createUser("A1");
    const a2 = await createUser("A2");
    await addMembership(a1, family, "parent", { isPrimaryAdmin: true });
    await addMembership(a2, family, "parent");

    const res = await as(a2)
      .post("/api/invitations")
      .send({ familyId: family.id, email: "nouveau@test.local", role: "parent" });
    expect(res.status).toBe(403);
  });

  it("refuse l'acceptation par un compte déjà membre d'un autre espace", async () => {
    const familyA = await createFamily("A");
    const familyB = await createFamily("B");
    const user = await createUser("Fatou");
    await addMembership(user, familyA, "adult");
    await db.insert(pendingInvitations).values({
      familyId: familyB.id,
      email: user.email,
      role: "adult",
      token: "jeton-invitation-test",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await as(user).post("/api/invitations/jeton-invitation-test/accept");
    expect(res.status).toBe(409);
    const memberships = await db.select().from(familyMemberships).where(eq(familyMemberships.userId, user.id));
    expect(memberships).toHaveLength(1);
  });

  it("accepte l'invitation d'un compte sans espace", async () => {
    const family = await createFamily();
    const user = await createUser("Fatou");
    await db.insert(pendingInvitations).values({
      familyId: family.id,
      email: user.email,
      role: "adult",
      token: "jeton-invitation-ok",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await as(user).post("/api/invitations/jeton-invitation-ok/accept");
    expect(res.status).toBe(200);
  });
});

describe("Rôles de dossier (UC-04)", () => {
  it("refuse d'attribuer un rôle à un compte d'une autre famille", async () => {
    const { family, a1 } = await createFamilyWithAdmins("Ndiaye");
    const member = await createMember(family);
    const outsider = await createUser("Extérieur");
    await addMembership(outsider, await createFamily("Autre"), "parent", { isPrimaryAdmin: true });

    const res = await as(a1).post("/api/document-roles").send({ memberId: member.id, userId: outsider.id, role: "relais" });
    expect(res.status).toBe(400);
  });

  it("attribue un rôle à un compte de la famille", async () => {
    const { family, a1, adult } = await createFamilyWithAdmins();
    const member = await createMember(family);
    const res = await as(a1).post("/api/document-roles").send({ memberId: member.id, userId: adult.id, role: "relais" });
    expect(res.status).toBe(201);
  });
});
