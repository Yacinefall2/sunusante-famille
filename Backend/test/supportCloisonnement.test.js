import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import {
  activityLog,
  appointments,
  documents,
  emergencyCards,
  members,
  notifications,
  supportRequests,
  treatmentMedications,
  treatments,
  users,
  vaccinations,
} from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { referenceFor } from "../src/lib/supportRequests.js";
import { runWorkerCycle } from "../src/reminders/cycle.js";
import { resetDatabase, createFamily, addMembership, createMember, linkMember, createSupport, asSupport } from "./helpers.js";

// Cloisonnement absolu (A5) : le support agit sur les comptes et les
// métadonnées techniques, JAMAIS sur les dossiers. On remplit une famille de
// données médicales, puis on parcourt toutes les réponses JSON des routes
// /api/admin/* : aucune valeur médicale ne doit y apparaître.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendSupportUpdateEmail: vi.fn(async () => {}),
  sendSupportConfirmationEmail: vi.fn(async () => {}),
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendAccountSuspendedEmail: vi.fn(async () => {}),
  sendFamilyAccountSuspendedEmail: vi.fn(async () => {}),
  sendNotificationEmail: vi.fn(async () => "id"),
}));

// Valeurs médicales semées dans la famille : aucune ne doit sortir.
const MEDICAL = {
  allergies: "Allergie-Arachide-Z9",
  memberNotes: "Note-Medicale-Confidentielle-Z9",
  bloodType: "AB-Z9",
  doctor: "Dr-Traitant-Z9",
  appointmentTitle: "RDV-Cardiologie-Z9",
  appointmentNotes: "Note-RDV-Z9",
  appointmentLocation: "Clinique-Z9",
  disease: "Hypertension-Z9",
  medication: "Amlodipine-Z9",
  dosage: "5mg-Z9",
  vaccine: "Vaccin-Fievre-Jaune-Z9",
  documentTitle: "Ordonnance-Z9",
  documentDescription: "Resultat-Analyse-Z9",
  documentFile: "analyse-sang-Z9.pdf",
  emergencyInfo: "Info-Urgence-Diabete-Z9",
  notificationTitle: "Notification-Amlodipine-Z9",
};

let a1, fatou, family, support;

async function seedMedicalFamily() {
  family = await createFamily("Famille Sow");
  [a1] = await db.insert(users).values({ email: "a1@test.local", passwordHash: await hashPassword("Mon-mdp-123"), name: "Awa Sow", emailVerified: true }).returning();
  [fatou] = await db.insert(users).values({ email: "fatou@test.local", passwordHash: await hashPassword("Mon-mdp-123"), name: "Fatou Sow", emailVerified: true }).returning();
  await addMembership(a1, family, "parent", { isPrimaryAdmin: true });
  const m = await addMembership(fatou, family, "adult");
  const fiche = await createMember(family, "Fatou");
  await linkMember(m, fiche);
  const child = await createMember(family, "Enfant");
  for (const member of [fiche, child]) {
    await db
      .update(members)
      .set({ allergies: MEDICAL.allergies, notes: MEDICAL.memberNotes, bloodType: MEDICAL.bloodType, doctorName: MEDICAL.doctor, dateOfBirth: "1980-01-01" })
      .where(eq(members.id, member.id));
    await db.insert(appointments).values({
      memberId: member.id,
      title: MEDICAL.appointmentTitle,
      notes: MEDICAL.appointmentNotes,
      location: MEDICAL.appointmentLocation,
      appointmentDate: new Date(Date.now() + 20 * 3600e3),
    });
    const [t] = await db.insert(treatments).values({ memberId: member.id, disease: MEDICAL.disease }).returning();
    await db.insert(treatmentMedications).values({ treatmentId: t.id, name: MEDICAL.medication, dosage: MEDICAL.dosage });
    await db.insert(vaccinations).values({ memberId: member.id, vaccineName: MEDICAL.vaccine, dateAdministered: "2026-01-01" });
    await db.insert(documents).values({
      memberId: member.id,
      title: MEDICAL.documentTitle,
      description: MEDICAL.documentDescription,
      documentType: "ordonnance",
      originalName: MEDICAL.documentFile,
    });
  }
  await db.insert(emergencyCards).values({ memberId: fiche.id, tokenHash: "b".repeat(64), active: true, extraInfo: MEDICAL.emergencyInfo });
  await db.insert(notifications).values({ userId: fatou.id, familyId: family.id, memberId: fiche.id, category: "medication_intake", dedupeKey: "n1", title: MEDICAL.notificationTitle, body: MEDICAL.medication });
  await db.insert(activityLog).values({ familyId: family.id, actorName: "Awa Sow", action: "member_updated", memberId: fiche.id, memberName: "Fatou Test" });
}

async function seedRequests() {
  const base = { description: "Demande sans information médicale.", verifiedAt: new Date() };
  const rows = [
    { type: "recovery", status: "open", userId: fatou.id, accountEmail: fatou.email, requesterUserId: fatou.id, contactEmail: fatou.email, newEmail: "fatou2@test.local" },
    { type: "data_deletion", status: "open", userId: fatou.id, accountEmail: fatou.email, requesterUserId: fatou.id, contactEmail: fatou.email },
    { type: "report", status: "open", userId: fatou.id, accountEmail: fatou.email, requesterUserId: a1.id, contactEmail: a1.email, familyId: family.id, reportReason: "abusive" },
    { type: "other", status: "unverified", userId: null, accountEmail: "inconnu@test.local", contactEmail: "inconnu@test.local", verifiedAt: null },
  ];
  const out = [];
  for (const values of rows) {
    const [r] = await db.insert(supportRequests).values({ ...base, ...values }).returning();
    await db.update(supportRequests).set({ reference: referenceFor(r.id) }).where(eq(supportRequests.id, r.id));
    out.push(r);
  }
  return out;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedMedicalFamily();
  support = await asSupport((await createSupport()).user);
});

function expectNoMedicalData(responses) {
  const dump = JSON.stringify(responses);
  for (const [field, value] of Object.entries(MEDICAL)) {
    expect(dump.includes(value), `valeur médicale « ${field} » exposée au support`).toBe(false);
  }
}

describe("Cloisonnement : aucune donnée médicale dans l'espace support", () => {
  it("toutes les réponses JSON des routes /api/admin/* sont exemptes de contenu médical", async () => {
    const requests = await seedRequests();
    // De l'activité technique : connexions, passage du worker (qui crée des
    // rappels contenant des noms de médicaments), courriels.
    await request(app).post("/api/auth/login").send({ email: "fatou@test.local", password: "faux" });
    await request(app).post("/api/auth/login").send({ email: "fatou@test.local", password: "Mon-mdp-123" });
    await runWorkerCycle({ now: new Date(), sendMail: vi.fn(async () => "id") });
    // Le worker a bien créé des rappels médicaux (sinon le test ne prouverait rien).
    const created = await db.select().from(notifications);
    expect(JSON.stringify(created)).toContain(MEDICAL.appointmentTitle);

    const responses = [];
    const check = async (promise, expected = 200) => {
      const res = await promise;
      expect(res.status, `${res.req?.method} ${res.req?.path}`).toBe(expected);
      responses.push(res.body);
      return res;
    };

    await check(support.get("/api/admin/auth/me"));
    await check(support.get("/api/admin/dashboard"));
    await check(support.get("/api/admin/accounts?q=sow"));
    await check(support.get("/api/admin/accounts?q=test.local"));
    await check(support.get(`/api/admin/accounts/${fatou.id}`));
    await check(support.get(`/api/admin/accounts/${a1.id}`));
    await check(support.get("/api/admin/requests"));
    for (const type of ["recovery", "data_deletion", "report", "other"]) await check(support.get(`/api/admin/requests?type=${type}`));
    for (const r of requests) await check(support.get(`/api/admin/requests/${r.id}`));
    await check(support.post(`/api/admin/requests/${requests[0].id}/assign`));
    await check(support.post(`/api/admin/requests/${requests[0].id}/reply`).send({ message: "Bonjour, nous traitons votre demande." }), 201);
    await check(support.post(`/api/admin/requests/${requests[0].id}/send-reset-link`).send({ reason: "Identité confirmée" }));
    await check(support.post(`/api/admin/requests/${requests[2].id}/suspend`).send({ reason: "Signalement instruit" }));
    await check(support.post(`/api/admin/accounts/${fatou.id}/unsuspend`).send({ reason: "Levée après échange" }));
    await check(support.post(`/api/admin/requests/${requests[1].id}/status`).send({ status: "in_progress" }));
    await check(support.get("/api/admin/logs"));
    for (const category of ["auth", "worker", "email", "push", "security", "support", "http_error"]) {
      await check(support.get(`/api/admin/logs?category=${category}`));
    }
    await check(support.get("/api/admin/logs?q=Z9"));
    await check(support.get("/api/admin/audit"));

    // La fiche de compte : métadonnées seulement.
    const account = responses[4];
    expect(Object.keys(account).sort()).toEqual(
      ["createdAt", "currentLoginFailures", "email", "emailVerified", "failedLogins24h", "families", "id", "lastLoginAt", "name", "openSessions", "pushDevices", "requests", "suspension"].sort()
    );
    expect(account.families).toEqual([expect.objectContaining({ name: "Famille Sow", role: "adult", isPrimaryAdmin: false })]);
    expect(account.failedLogins24h).toBe(1);

    expectNoMedicalData(responses);
  });

  it("le code des routes du support n'importe aucune table médicale", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const forbidden = [
      "members",
      "appointments",
      "treatments",
      "treatmentMedications",
      "vaccinations",
      "documents",
      "documentRoles",
      "emergencyCards",
      "emergencyCardViews",
      "activityLog",
      "notifications",
      "medicationIntakes",
      "relayTasks",
      "consentAttestations",
    ];
    for (const file of ["routes/admin.js", "routes/adminAuth.js", "middleware/supportAuth.js"]) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      const schemaImport = source.match(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/db\/schema\.js"/);
      const imported = schemaImport ? schemaImport[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
      for (const table of forbidden) expect(imported, `${file} importe ${table}`).not.toContain(table);
    }
  });
});
