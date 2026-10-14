import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import {
  appointments,
  doctorShares,
  familyMemberships,
  members,
  notifications,
  pushSubscriptions,
  refreshTokens,
  supportAudit,
  supportRequests,
  users,
} from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import {
  sendAccountReinstatedEmail,
  sendAccountSuspendedEmail,
  sendFamilyAccountReinstatedEmail,
  sendFamilyAccountSuspendedEmail,
  sendPasswordResetEmail,
  sendSupportEmailChangedNotice,
  sendVerificationEmail,
} from "../src/lib/mailer.js";
import { referenceFor } from "../src/lib/supportRequests.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { runWorkerCycle } from "../src/reminders/cycle.js";
import { resetDatabase, createFamily, addMembership, createMember, linkMember, createUser, createSupport, asSupport } from "./helpers.js";

// Actions du support (UC-50 à 52) : motif obligatoire, auditées, sur une
// demande vérifiée et ouverte (sauf le changement d'adresse).
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendAccountReinstatedEmail: vi.fn(async () => {}),
  sendAccountSuspendedEmail: vi.fn(async () => {}),
  sendFamilyAccountReinstatedEmail: vi.fn(async () => {}),
  sendFamilyAccountSuspendedEmail: vi.fn(async () => {}),
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendSupportEmailChangedNotice: vi.fn(async () => {}),
  sendVerificationEmail: vi.fn(async () => {}),
  sendSupportUpdateEmail: vi.fn(async () => {}),
  sendSupportConfirmationEmail: vi.fn(async () => {}),
}));

const PASSWORD = "Mon-mdp-123";
const REASON = "Signalement instruit : messages abusifs confirmés";
let a1, fatou, family, fiche, support, supportUser;

async function userWithPassword(email, name) {
  const [u] = await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), name, emailVerified: true }).returning();
  return u;
}

const login = (email, password = PASSWORD, ip = "203.0.113.10") =>
  request(app).post("/api/auth/login").set("X-Forwarded-For", ip).send({ email, password });

async function loggedIn(email) {
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

async function supportRequest(values) {
  const [row] = await db
    .insert(supportRequests)
    .values({ status: "open", contactEmail: values.accountEmail ?? "contact@test.local", description: "Demande de test du support.", verifiedAt: new Date(), ...values })
    .returning();
  const [withRef] = await db.update(supportRequests).set({ reference: referenceFor(row.id) }).where(eq(supportRequests.id, row.id)).returning();
  return withRef;
}

const auditActions = async () => (await db.select().from(supportAudit)).map((a) => a.action);

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  family = await createFamily("Diop");
  a1 = await userWithPassword("a1@test.local", "Awa Diop");
  await addMembership(a1, family, "parent", { isPrimaryAdmin: true });
  fatou = await userWithPassword("fatou@test.local", "Fatou Sow");
  const m = await addMembership(fatou, family, "adult");
  fiche = await createMember(family, "Fatou");
  await db.update(members).set({ dateOfBirth: "1980-05-01" }).where(eq(members.id, fiche.id));
  await linkMember(m, fiche);
  supportUser = (await createSupport("Agent Ndiaye")).user;
  support = await asSupport(supportUser);
});

describe("UC-50 : récupération de compte", () => {
  it("lien de réinitialisation : à l'adresse du compte, sur une demande vérifiée seulement, motif obligatoire", async () => {
    const unverified = await supportRequest({ type: "recovery", status: "unverified", verifiedAt: null, userId: fatou.id, accountEmail: fatou.email });
    expect((await support.post(`/api/admin/requests/${unverified.id}/send-reset-link`).send({ reason: "Demande confirmée" })).status).toBe(409);

    const open = await supportRequest({ type: "recovery", userId: fatou.id, accountEmail: fatou.email });
    expect((await support.post(`/api/admin/requests/${open.id}/send-reset-link`).send({})).status).toBe(400);
    const res = await support.post(`/api/admin/requests/${open.id}/send-reset-link`).send({ reason: "Identité confirmée par le lien" });
    expect(res.status).toBe(200);
    expect(res.body.sentTo).toBe("f***@test.local");
    expect(vi.mocked(sendPasswordResetEmail).mock.lastCall[0].to).toBe("fatou@test.local");
    // Le support ne voit jamais le lien ni le mot de passe.
    expect(JSON.stringify(res.body)).not.toContain(vi.mocked(sendPasswordResetEmail).mock.lastCall[0].token);
    expect(await auditActions()).toContain("reset_link_sent");
    const [row] = await db.select().from(supportRequests).where(eq(supportRequests.id, open.id));
    expect(row.status).toBe("in_progress");
  });

  it("déblocage du limiteur de connexion du compte", async () => {
    for (let i = 0; i < 5; i++) await login("fatou@test.local", "mauvais");
    expect((await login("fatou@test.local")).status).toBe(429);
    const open = await supportRequest({ type: "recovery", userId: fatou.id, accountEmail: fatou.email });
    expect((await support.post(`/api/admin/requests/${open.id}/unlock`).send({ reason: "Bloquée après oubli du mot de passe" })).status).toBe(200);
    expect((await login("fatou@test.local")).status).toBe(200);
    expect(await auditActions()).toContain("login_unlocked");
  });

  it("changement d'adresse : case « identité vérifiée hors application » et motif détaillé exigés ; sessions fermées ; courriels", async () => {
    const agent = await loggedIn("fatou@test.local");
    const req = await supportRequest({
      type: "recovery",
      status: "unverified",
      verifiedAt: null,
      userId: fatou.id,
      accountEmail: fatou.email,
      newEmail: "fatou.nouvelle@test.local",
      contactEmail: "fatou.nouvelle@test.local",
    });
    const url = `/api/admin/requests/${req.id}/change-email`;
    const detailed = "Identité vérifiée par appel vidéo avec pièce d'identité, le 12/10.";
    expect((await support.post(url).send({ reason: detailed })).status).toBe(400);
    expect((await support.post(url).send({ reason: "trop court", identityVerifiedOffline: true })).status).toBe(400);

    const res = await support.post(url).send({ reason: detailed, identityVerifiedOffline: true });
    expect(res.status).toBe(200);
    const [after] = await db.select().from(users).where(eq(users.id, fatou.id));
    expect(after.email).toBe("fatou.nouvelle@test.local");
    expect(after.emailVerified).toBe(false);
    // Toutes les sessions fermées, y compris le jeton d'accès encore valide.
    expect((await agent.get("/api/auth/me")).status).toBe(401);
    expect((await agent.post("/api/auth/refresh")).status).toBe(401);
    const open = await db.select().from(refreshTokens).where(and(eq(refreshTokens.userId, fatou.id), sql`${refreshTokens.revokedAt} is null`));
    expect(open).toHaveLength(0);
    // Lien de vérification à la nouvelle adresse, avis à l'ancienne.
    expect(vi.mocked(sendVerificationEmail).mock.lastCall[0].to).toBe("fatou.nouvelle@test.local");
    expect(vi.mocked(sendSupportEmailChangedNotice).mock.lastCall[0]).toMatchObject({ to: "fatou@test.local", newEmailMasked: "f***@test.local" });
    const [entry] = await db.select().from(supportAudit).where(eq(supportAudit.action, "email_changed"));
    expect(entry).toMatchObject({ supportUserId: supportUser.id, targetUserId: fatou.id, reason: detailed, requestId: req.id });
    // Le support ne définit aucun mot de passe : l'ancienne adresse ne connecte plus.
    expect((await login("fatou@test.local")).status).toBe(401);
  });

  it("changement d'adresse refusé si la nouvelle adresse appartient déjà à un compte", async () => {
    const req = await supportRequest({ type: "recovery", userId: fatou.id, accountEmail: fatou.email, newEmail: "a1@test.local" });
    const res = await support
      .post(`/api/admin/requests/${req.id}/change-email`)
      .send({ reason: "Identité vérifiée par téléphone avec le parent A1.", identityVerifiedOffline: true });
    expect(res.status).toBe(409);
  });
});

describe("UC-51 : suppression des données", () => {
  const url = (id) => `/api/admin/requests/${id}/delete-account`;
  const body = { reason: "Demande écrite confirmée par lien", confirmEmail: "fatou@test.local" };

  it("mêmes règles que la suppression par la personne : fiche archivée, demande traitée", async () => {
    const req = await supportRequest({ type: "data_deletion", userId: fatou.id, accountEmail: fatou.email, requesterUserId: fatou.id });
    expect((await support.post(url(req.id)).send({ ...body, confirmEmail: "autre@test.local" })).status).toBe(400);
    expect((await support.post(url(req.id)).send({ ...body, deleteMedicalRecord: true })).status).toBe(400); // non demandé
    const res = await support.post(url(req.id)).send(body);
    expect(res.status).toBe(200);
    expect(await db.select().from(users).where(eq(users.id, fatou.id))).toHaveLength(0);
    const [kept] = await db.select().from(members).where(eq(members.id, fiche.id));
    expect(kept.archivedAt).not.toBeNull(); // la fiche reste à la famille, archivée
    const [row] = await db.select().from(supportRequests).where(eq(supportRequests.id, req.id));
    expect(row.status).toBe("resolved");
    expect(await auditActions()).toContain("account_deleted");
  });

  it("fiche médicale effacée seulement si la personne l'a demandé", async () => {
    const req = await supportRequest({ type: "data_deletion", userId: fatou.id, accountEmail: fatou.email, deleteMedicalRecord: true });
    expect((await support.post(url(req.id)).send({ ...body, deleteMedicalRecord: true })).status).toBe(200);
    expect(await db.select().from(members).where(eq(members.id, fiche.id))).toHaveLength(0);
  });

  it("A1 d'un espace qui compte d'autres comptes : refus avec explication", async () => {
    const req = await supportRequest({ type: "data_deletion", userId: a1.id, accountEmail: a1.email });
    const res = await support.post(url(req.id)).send({ ...body, confirmEmail: "a1@test.local" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/administre « Diop »/);
    expect(await db.select().from(users).where(eq(users.id, a1.id))).toHaveLength(1);
  });

  it("demande non vérifiée : suppression impossible", async () => {
    const req = await supportRequest({ type: "data_deletion", status: "unverified", verifiedAt: null, userId: fatou.id, accountEmail: fatou.email });
    expect((await support.post(url(req.id)).send(body)).status).toBe(409);
  });
});

describe("UC-52 : suspension d'un compte signalé", () => {
  let report, appointmentId;

  beforeEach(async () => {
    report = await supportRequest({ type: "report", userId: fatou.id, accountEmail: fatou.email, requesterUserId: a1.id, familyId: family.id, reportReason: "abusive" });
    await db.insert(pushSubscriptions).values({ userId: fatou.id, endpoint: "https://push.exemple/abc", p256dh: "cle", auth: "auth" });
    await db.insert(doctorShares).values({
      memberId: fiche.id,
      familyId: family.id,
      createdByUserId: fatou.id,
      tokenHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 24 * 3600e3),
    });
    [{ id: appointmentId }] = await db
      .insert(appointments)
      .values({ memberId: fiche.id, title: "Consultation", appointmentDate: new Date(Date.now() + 20 * 3600e3) })
      .returning();
  });

  const suspend = (extra = {}) => support.post(`/api/admin/requests/${report.id}/suspend`).send({ reason: REASON, ...extra });

  it("connexion refusée — révélée seulement après le bon mot de passe ; sessions, push et liens médecin révoqués ; données intactes", async () => {
    const agent = await loggedIn("fatou@test.local");
    expect((await suspend()).status).toBe(200);

    expect((await agent.get("/api/auth/me")).status).toBe(401);
    expect((await agent.post("/api/auth/refresh")).status).toBe(401);
    const wrong = await login("fatou@test.local", "mauvais");
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("Identifiants invalides");
    const right = await login("fatou@test.local");
    expect(right.status).toBe(403);
    expect(right.body.code).toBe("ACCOUNT_SUSPENDED");
    expect(right.body.error).toMatch(/suspendu jusqu'à nouvel ordre/);
    expect(right.body.error).toContain(REASON);
    expect(right.body.error).toMatch(/contester/);

    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, fatou.id))).toHaveLength(0);
    const [share] = await db.select().from(doctorShares);
    expect(share.revokedAt).not.toBeNull();
    const tokens = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, fatou.id));
    expect(tokens.every((t) => t.revokedAt)).toBe(true);

    // Rien n'est supprimé ni archivé.
    const [stillThere] = await db.select().from(members).where(eq(members.id, fiche.id));
    expect(stillThere.archivedAt).toBeNull();
    const [membership] = await db.select().from(familyMemberships).where(eq(familyMemberships.userId, fatou.id));
    expect(membership.linkedMemberId).toBe(fiche.id);
    expect(await db.select().from(appointments).where(eq(appointments.id, appointmentId))).toHaveLength(1);

    expect(await auditActions()).toContain("account_suspended");
    expect((await suspend()).status).toBe(409); // déjà suspendu
  });

  it("la personne est prévenue (motif, durée) ; A1 est prévenu SANS le motif", async () => {
    await suspend();
    expect(vi.mocked(sendAccountSuspendedEmail).mock.lastCall[0]).toMatchObject({ to: "fatou@test.local", reason: REASON, endLabel: "jusqu'à nouvel ordre" });
    const toA1 = vi.mocked(sendFamilyAccountSuspendedEmail).mock.lastCall[0];
    expect(toA1).toMatchObject({ to: "a1@test.local", memberName: "Fatou Sow", familyName: "Diop" });
    expect(JSON.stringify(toA1)).not.toContain(REASON);
    const [notice] = await db.select().from(notifications).where(eq(notifications.userId, a1.id));
    expect(notice.title).toBe("Un compte de votre famille est suspendu");
    expect(`${notice.title} ${notice.body}`).not.toContain(REASON);
  });

  it("le compte suspendu ne reçoit plus rien ; ses rappels vont aux autres (A1)", async () => {
    // Notification déjà en attente d'envoi par courriel avant la suspension.
    await db.insert(notifications).values({
      userId: fatou.id,
      category: "appointment_reminder",
      dedupeKey: "avant-suspension",
      title: "Rappel",
      emailStatus: "pending",
      emailNextAttemptAt: new Date(),
    });
    await suspend();
    const sendMail = vi.fn(async () => "id-message");
    await runReminderTick({ now: new Date(), sendMail });
    const fatouNotifications = await db.select().from(notifications).where(eq(notifications.userId, fatou.id));
    expect(fatouNotifications.map((n) => n.dedupeKey)).toEqual(["avant-suspension"]);
    expect(fatouNotifications[0].emailStatus).toBe("skipped");
    expect(sendMail.mock.calls.some(([m]) => m.to === "fatou@test.local")).toBe(false);
    const toA1 = await db.select().from(notifications).where(and(eq(notifications.userId, a1.id), eq(notifications.category, "appointment_reminder")));
    expect(toA1).toHaveLength(1);
  });

  it("levée manuelle : connexion de nouveau possible, courriels envoyés", async () => {
    await suspend();
    expect((await support.post(`/api/admin/accounts/${fatou.id}/unsuspend`).send({})).status).toBe(400);
    const res = await support.post(`/api/admin/accounts/${fatou.id}/unsuspend`).send({ reason: "Contestation acceptée" });
    expect(res.status).toBe(200);
    expect(res.body.suspension).toBeNull();
    expect((await login("fatou@test.local")).status).toBe(200);
    expect(vi.mocked(sendAccountReinstatedEmail).mock.lastCall[0].to).toBe("fatou@test.local");
    expect(vi.mocked(sendFamilyAccountReinstatedEmail).mock.lastCall[0].to).toBe("a1@test.local");
    expect(await auditActions()).toContain("suspension_lifted");
    expect((await support.post(`/api/admin/accounts/${fatou.id}/unsuspend`).send({ reason: "Encore" })).status).toBe(409);
  });

  it("levée automatique par le worker à la date de fin", async () => {
    const until = new Date(Date.now() + 3600e3);
    expect((await suspend({ until: until.toISOString() })).status).toBe(200);
    expect((await suspend({ until: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await login("fatou@test.local")).body.error).toMatch(/suspendu jusqu'au/);
    await runWorkerCycle({ now: new Date(until.getTime() + 60e3), sendMail: vi.fn(async () => "id") });
    const [after] = await db.select().from(users).where(eq(users.id, fatou.id));
    expect(after.suspendedAt).toBeNull();
    expect(await auditActions()).toContain("suspension_lifted_auto");
    expect(vi.mocked(sendAccountReinstatedEmail)).toHaveBeenCalled();
    expect((await login("fatou@test.local")).status).toBe(200);
  });

  it("la suspension exige une demande de signalement ouverte", async () => {
    const other = await supportRequest({ type: "other", userId: fatou.id, accountEmail: fatou.email });
    expect((await support.post(`/api/admin/requests/${other.id}/suspend`).send({ reason: REASON })).status).toBe(409);
    await db.update(supportRequests).set({ status: "resolved" }).where(eq(supportRequests.id, report.id));
    expect((await suspend()).status).toBe(409);
  });
});

describe("Journal d'audit ineffaçable", () => {
  it("ni modification ni suppression possibles", async () => {
    const someone = await createUser("Quelqu'un");
    await support.get(`/api/admin/accounts/${someone.id}`);
    const [entry] = await db.select().from(supportAudit).where(eq(supportAudit.action, "account_viewed"));
    expect(entry).toMatchObject({ supportUserId: supportUser.id, targetUserId: someone.id, targetEmail: someone.email });
    await expect(db.execute(sql`update support_audit set reason = 'modifié' where id = ${entry.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from support_audit where id = ${entry.id}`)).rejects.toThrow();
    // La suppression du compte visé ne touche pas au journal.
    await db.delete(users).where(eq(users.id, someone.id));
    const [still] = await db.select().from(supportAudit).where(eq(supportAudit.id, entry.id));
    expect(still.targetEmail).toBe(someone.email);
  });

  it("chaque action est tracée avec le compte support, la cible, le motif et l'adresse IP", async () => {
    const req = await supportRequest({ type: "recovery", userId: fatou.id, accountEmail: fatou.email });
    await support.post(`/api/admin/requests/${req.id}/status`).set("X-Forwarded-For", "192.0.2.44").send({ status: "rejected", reason: "Demande en double" });
    const [entry] = await db.select().from(supportAudit).where(eq(supportAudit.action, "request_status_changed"));
    expect(entry).toMatchObject({ supportUserId: supportUser.id, requestId: req.id, reason: "Demande en double", ip: "192.0.2.44" });
    const page = await support.get("/api/admin/audit");
    expect(page.status).toBe(200);
    expect(page.body.items.some((e) => e.action === "request_status_changed" && e.actionLabel)).toBe(true);
  });

  it("ouvrir une demande non vérifiée exige la vérification d'identité hors application", async () => {
    const req = await supportRequest({ type: "recovery", status: "unverified", verifiedAt: null, userId: fatou.id, accountEmail: fatou.email });
    expect((await support.post(`/api/admin/requests/${req.id}/status`).send({ status: "open" })).status).toBe(400);
    expect((await support.post(`/api/admin/requests/${req.id}/status`).send({ status: "resolved" })).status).toBe(409);
    const ok = await support
      .post(`/api/admin/requests/${req.id}/status`)
      .send({ status: "open", identityVerifiedOffline: true, reason: "Rappel au numéro connu de la famille" });
    expect(ok.status).toBe(200);
    expect(ok.body.request.verifiedOfflineAt).not.toBeNull();
  });
});
