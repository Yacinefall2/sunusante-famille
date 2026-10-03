import request from "supertest";
import { eq, sql } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import {
  users,
  families,
  familyMemberships,
  members,
  appointments,
  treatments,
  vaccinations,
  documents,
  documentRoles,
} from "../src/db/schema.js";
import { signAccessToken } from "../src/lib/jwt.js";

export async function resetDatabase() {
  await db.execute(sql`
    truncate table users, families, members, document_roles, appointments, treatments,
      treatment_medications, vaccinations, documents, email_verification_tokens,
      family_memberships, refresh_tokens, pending_invitations, notifications,
      medication_intakes, notification_preferences
    restart identity cascade
  `);
}

let userCounter = 0;

export async function createUser(name = "Utilisateur") {
  userCounter += 1;
  const [user] = await db
    .insert(users)
    .values({
      email: `user${userCounter}-${Date.now()}@test.local`,
      // Les tests n'ouvrent pas de session par /login : le hash n'est jamais vérifié.
      passwordHash: "non-utilise",
      name,
      emailVerified: true,
    })
    .returning();
  return user;
}

export async function createFamily(name = "Famille") {
  const [family] = await db.insert(families).values({ name }).returning();
  return family;
}

export async function addMembership(user, family, role = "adult", extra = {}) {
  const [membership] = await db
    .insert(familyMemberships)
    .values({ userId: user.id, familyId: family.id, role, ...extra })
    .returning();
  return membership;
}

export async function createMember(family, firstName = "Fiche") {
  const [member] = await db
    .insert(members)
    .values({ familyId: family.id, firstName, lastName: "Test" })
    .returning();
  return member;
}

// Relie un compte à sa fiche (il en devient Titulaire).
export async function linkMember(membership, member) {
  await db.update(familyMemberships).set({ linkedMemberId: member.id }).where(eq(familyMemberships.id, membership.id));
  membership.linkedMemberId = member.id;
}

export async function grantRole(member, user, role) {
  await db.insert(documentRoles).values({ memberId: member.id, userId: user.id, role });
}

// Une donnée médicale de chaque type sur une fiche — de quoi détecter toute fuite.
export async function seedMedicalData(member) {
  await db.insert(appointments).values({ memberId: member.id, title: "RDV secret", appointmentDate: new Date() });
  await db.insert(treatments).values({ memberId: member.id, disease: "Traitement secret" });
  await db.insert(vaccinations).values({ memberId: member.id, vaccineName: "Vaccin secret", dateAdministered: "2026-01-01" });
  await db.insert(documents).values({ memberId: member.id, title: "Document secret", documentType: "ordonnance" });
}

// Client HTTP authentifié comme `user` (cookie de session signé directement).
export function as(user) {
  const cookie = `access_token=${signAccessToken(user)}`;
  return {
    get: (url) => request(app).get(url).set("Cookie", cookie),
    post: (url) => request(app).post(url).set("Cookie", cookie),
    put: (url) => request(app).put(url).set("Cookie", cookie),
    delete: (url) => request(app).delete(url).set("Cookie", cookie),
  };
}

// Famille complète : A1 (créateur), A2 (co-administrateur), un membre adulte.
export async function createFamilyWithAdmins(name = "Famille") {
  const family = await createFamily(name);
  const a1 = await createUser(`${name} A1`);
  const a2 = await createUser(`${name} A2`);
  const adult = await createUser(`${name} adulte`);
  const a1Membership = await addMembership(a1, family, "parent", { isPrimaryAdmin: true });
  const a2Membership = await addMembership(a2, family, "parent");
  const adultMembership = await addMembership(adult, family, "adult");
  return { family, a1, a2, adult, a1Membership, a2Membership, adultMembership };
}
