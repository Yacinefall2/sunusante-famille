import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import { activityLog, appointments, families, members, relayTasks, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { sendDoctorShareEmail, sendInvitationEmail } from "../src/lib/mailer.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, grantRole, attest, attestation, as } from "./helpers.js";

// Journal d'activité (UC-10, §10 « Traçabilité », §6.3) : ce qui est tracé,
// qui le voit, et l'impossibilité de le modifier.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendInvitationEmail: vi.fn(async () => {}),
  sendDoctorShareEmail: vi.fn(async () => {}),
}));

const PASSWORD = "Mon-mdp-123";
const DOCTOR = "dr.ndiaye@clinique.sn";

// Foyer Fall : Mouhamed (A1) et Dior (A2) avec leurs fiches, Medoune (adulte,
// sa fiche), Toutou (adolescente, sa fiche), Cousin (gestionnaire de Mamie,
// proche non connecté), Omar (relais de Mamie).
let f;
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  const family = await createFamily("Fall");
  const [papa, maman, toutou, cousin, omar] = await Promise.all(
    ["Mouhamed Fall", "Dior Fall", "Toutou Fall", "Cousin Fall", "Omar Fall"].map((n) => createUser(n))
  );
  const [medoune] = await db
    .insert(users)
    .values({ email: "medoune@test.local", passwordHash: await hashPassword(PASSWORD), name: "Medoune Fall", emailVerified: true })
    .returning();
  const pm = await addMembership(papa, family, "parent", { isPrimaryAdmin: true });
  const mm = await addMembership(maman, family, "parent");
  const sm = await addMembership(medoune, family, "adult");
  const tm = await addMembership(toutou, family, "adult");
  await addMembership(cousin, family, "adult");
  await addMembership(omar, family, "adult");
  const fiche = async (firstName, data, membership) => {
    const m = await createMember(family, firstName);
    await db.update(members).set({ lastName: "Fall", ...data }).where(eq(members.id, m.id));
    if (membership) await linkMember(membership, m);
    return { ...m, lastName: "Fall", ...data };
  };
  const fPapa = await fiche("Mouhamed", { dateOfBirth: "1966-12-11" }, pm);
  const fMaman = await fiche("Dior", { dateOfBirth: "1976-04-22" }, mm);
  const fMedoune = await fiche("Medoune", { dateOfBirth: "2004-06-10", bloodType: "O+" }, sm);
  const fToutou = await fiche("Toutou", { dateOfBirth: "2011-08-25" }, tm); // 15 ans : adolescente
  const fMamie = await fiche("Mamie", { dateOfBirth: "1940-01-01", status: "non_connecte", phone: "+221770000000" });
  await grantRole(fMamie, cousin, "gestionnaire");
  await grantRole(fMamie, omar, "relais");
  await attest(fMamie, cousin); // accord oral de Mamie attesté (UC-29)
  f = { family, papa, maman, medoune, toutou, cousin, omar, sm, fPapa, fMaman, fMedoune, fToutou, fMamie };
});

const journal = async (user, query = "") => {
  const res = await as(user).get(`/api/activity?familyId=${f.family.id}${query}`);
  expect(res.status).toBe(200);
  return res.body;
};
const texts = async (user, query) => (await journal(user, query)).entries.map((e) => e.text);
const actions = async (user, query) => (await journal(user, query)).entries.map((e) => e.action);
const sentDoctorToken = () => vi.mocked(sendDoctorShareEmail).mock.lastCall[0].link.split("/medecin/")[1];
const share = (user, memberId, body = {}) =>
  as(user).post("/api/doctor-shares").send({ memberId, doctorEmail: DOCTOR, duration: "24h", includeTreatments: true, ...body });

describe("Journal — ce qui est enregistré", () => {
  it("une invitation est tracée dès l'émission, avec le rôle d'espace et le rôle de dossier ; puis son annulation", async () => {
    const res = await as(f.papa)
      .post("/api/invitations")
      .send({ familyId: f.family.id, email: "Nouveau@Test.local", role: "member", documentMemberId: f.fMamie.id, documentRole: "relais" });
    expect(res.status).toBe(201);
    const [entry] = (await journal(f.papa)).entries;
    expect(entry).toMatchObject({ action: "invitation_sent", category: "invitations", memberId: f.fMamie.id });
    expect(entry.text).toBe(
      "Mouhamed Fall a invité nouveau@test.local comme membre de la famille — rôle relais sur le dossier de Mamie Fall"
    );

    expect((await as(f.papa).delete(`/api/invitations?id=${res.body.id}`)).status).toBe(200);
    expect((await texts(f.papa))[0]).toBe("Mouhamed Fall a annulé l'invitation envoyée à nouveau@test.local");
  });

  it("acceptation : arrivée dans l'espace et rôle de dossier appliqué", async () => {
    await as(f.papa)
      .post("/api/invitations")
      .send({ familyId: f.family.id, email: "awa@test.local", role: "member", documentMemberId: f.fMamie.id, documentRole: "lecteur_invite" });
    const token = vi.mocked(sendInvitationEmail).mock.lastCall[0].token;
    const awa = await createUser("Awa Ndiaye");
    await db.update(users).set({ email: "awa@test.local" }).where(eq(users.id, awa.id));
    expect((await as({ ...awa, email: "awa@test.local" }).post(`/api/invitations/${token}/accept`)).status).toBe(200);
    const list = await texts(f.papa);
    expect(list).toContain("Awa Ndiaye a rejoint l'espace familial comme membre de la famille (invitation de Mouhamed Fall)");
    expect(list).toContain("Mouhamed Fall a attribué le rôle lecteur invité à Awa Ndiaye sur le dossier de Mamie Fall (invitation acceptée)");
  });

  it("rôles de dossier : attribué, modifié, révoqué", async () => {
    const granted = await as(f.papa).post("/api/document-roles").send({ memberId: f.fMamie.id, userId: f.medoune.id, role: "lecteur_invite" });
    expect(granted.status).toBe(201);
    const changed = await as(f.papa).post("/api/document-roles").send({ memberId: f.fMamie.id, userId: f.medoune.id, role: "gestionnaire" });
    expect((await as(f.papa).delete(`/api/document-roles?id=${changed.body.id}`)).status).toBe(200);
    expect(await texts(f.papa, "&category=roles")).toEqual([
      "Mouhamed Fall a révoqué le rôle gestionnaire de Medoune Fall sur le dossier de Mamie Fall",
      "Mouhamed Fall a changé le rôle de Medoune Fall sur le dossier de Mamie Fall : lecteur invité → gestionnaire",
      "Mouhamed Fall a attribué le rôle lecteur invité à Medoune Fall sur le dossier de Mamie Fall",
    ]);
  });

  it("partage médecin : envoyé (adresse, durée, éléments), ouvert, ouverture refusée, révoqué", async () => {
    const created = await share(f.medoune, f.fMedoune.id);
    expect(created.status).toBe(201);
    const token = sentDoctorToken();
    const doctor = request.agent(app);
    expect((await doctor.post(`/api/public/doctor/${token}/open`)).status).toBe(200);
    // Autre appareil : refusé, une seule entrée par heure.
    expect((await request(app).post(`/api/public/doctor/${token}/open`)).status).toBe(410);
    expect((await request(app).post(`/api/public/doctor/${token}/open`)).status).toBe(410);
    expect((await as(f.medoune).post(`/api/doctor-shares/${created.body.id}/revoke`)).status).toBe(200);

    expect(await texts(f.medoune, "&category=partage")).toEqual([
      `Medoune Fall a révoqué le lien médecin du dossier de Medoune Fall envoyé à ${DOCTOR}`,
      `Ouverture refusée du lien médecin du dossier de Medoune Fall envoyé à ${DOCTOR} : tentative depuis un autre appareil`,
      `Le lien médecin du dossier de Medoune Fall envoyé à ${DOCTOR} a été ouvert`,
      `Medoune Fall a envoyé un lien médecin pour le dossier de Medoune Fall à ${DOCTOR} (valable 24 heures) — éléments partagés : l'essentiel, les traitements`,
    ]);
  });

  it("fiche d'urgence : activée (champs publiés, sans valeurs), consultée une fois par minute, QR régénéré", async () => {
    const put = await as(f.medoune)
      .put(`/api/emergency/${f.fMedoune.id}`)
      .send({ active: true, fields: { showBloodType: true, showAllergies: true }, extraInfo: "Diabétique" });
    const token = put.body.url.split("/urgence/")[1];
    expect((await request(app).get(`/api/public/emergency/${token}`)).status).toBe(200);
    expect((await request(app).get(`/api/public/emergency/${token}`)).status).toBe(200);
    await as(f.medoune).post(`/api/emergency/${f.fMedoune.id}/regenerate`);
    await as(f.medoune).put(`/api/emergency/${f.fMedoune.id}`).send({ active: false, fields: {} });

    const list = await texts(f.medoune, "&category=urgence");
    expect(list).toEqual([
      "Medoune Fall a désactivé la fiche d'urgence de Medoune Fall",
      "Medoune Fall a régénéré le QR code de la fiche d'urgence de Medoune Fall : l'ancienne carte ne fonctionne plus",
      "La fiche d'urgence de Medoune Fall a été consultée (QR code ou lien)",
      "Medoune Fall a activé la fiche d'urgence de Medoune Fall — informations publiées : groupe sanguin, allergies, informations complémentaires",
    ]);
    const all = JSON.stringify(await journal(f.medoune));
    for (const value of ["O+", "Diabétique"]) expect(all).not.toContain(value);
  });

  it("Village : « Prévenu » et « Pas joignable » par le relais, sans le motif du rendez-vous", async () => {
    const now = new Date();
    const rdv = new Date(now.getTime() + 70 * 3600e3);
    await db.insert(appointments).values({ memberId: f.fMamie.id, title: "Suivi cardiologie", location: "Kolda", appointmentDate: rdv, status: "confirmed" });
    await runReminderTick({ now, sendMail: async () => "<id@test>" });
    const [task] = await db.select().from(relayTasks);
    expect(task).toBeTruthy();
    expect((await as(f.cousin).post(`/api/village/tasks/${task.id}/unreachable`)).status).toBe(200);
    expect((await as(f.cousin).post(`/api/village/tasks/${task.id}/notified`)).status).toBe(200);
    const list = await journal(f.papa, "&category=village");
    expect(list.entries.map((e) => e.action)).toEqual(["relay_notified", "relay_unreachable"]);
    expect(list.entries[0].text).toMatch(/^Cousin Fall a prévenu Mamie Fall de son rendez-vous du /);
    expect(JSON.stringify(list)).not.toContain("cardiologie");
  });

  it("présence au rendez-vous d'un proche du Village : venu / pas venu", async () => {
    const past = new Date(Date.now() - 24 * 3600e3);
    const [appt] = await db
      .insert(appointments)
      .values({ memberId: f.fMamie.id, title: "Suivi cardiologie", appointmentDate: past, status: "confirmed" })
      .returning();
    await db.insert(relayTasks).values({ appointmentId: appt.id, memberId: f.fMamie.id, familyId: f.family.id, appointmentDate: past });
    expect((await as(f.cousin).put("/api/appointments/attendance").send({ id: appt.id, attendance: "missed" })).status).toBe(200);
    const [entry] = (await journal(f.papa, "&category=village")).entries;
    expect(entry.text).toMatch(/^Cousin Fall a indiqué la présence de Mamie Fall au rendez-vous du .* : pas venu\(e\)$/);
  });

  it("fiches et liaisons : créée, date de naissance modifiée (sans la date), supprimée", async () => {
    const created = await as(f.papa)
      .post("/api/members")
      .send({ familyId: f.family.id, firstName: "Bébé", lastName: "Fall", dateOfBirth: "2025-01-01", gender: "F", kinship: "enfant" });
    expect(created.status).toBe(201);
    const birth = await as(f.medoune).put("/api/members").send({ ...f.fMedoune, id: f.fMedoune.id, gender: "M", kinship: "enfant", dateOfBirth: "2003-06-10" });
    expect(birth.status).toBe(200);
    expect(await texts(f.papa, "&category=fiches")).toEqual([
      "Medoune Fall a modifié la date de naissance de la fiche de Medoune Fall",
      "Mouhamed Fall a créé la fiche de Bébé Fall et en est gestionnaire",
    ]);
    expect((await as(f.papa).delete(`/api/members?id=${created.body.id}`)).status).toBe(200);
    // Fiche supprimée : plus aucun accès, donc seule sa suppression reste visible.
    const list = await texts(f.papa, "&category=fiches");
    expect(list).toEqual([
      "Mouhamed Fall a supprimé la fiche de Bébé Fall",
      "Medoune Fall a modifié la date de naissance de la fiche de Medoune Fall",
    ]);
    expect(list.join(" ")).not.toContain("2003");
  });

  it("espace : liaison d'un compte à une fiche (rôles retirés en un récapitulatif), promotion co-administrateur", async () => {
    const x = await as(f.papa)
      .post("/api/members")
      .send({ familyId: f.family.id, firstName: "Ibou", lastName: "Fall", dateOfBirth: "1990-01-01", gender: "M", kinship: "cousin", consent: attestation(f.papa) });
    await as(f.papa).post("/api/document-roles").send({ memberId: x.body.id, userId: f.omar.id, role: "relais" });
    const accounts = (await as(f.papa).get(`/api/family-memberships?familyId=${f.family.id}`)).body;
    const cousin = accounts.find((m) => m.userId === f.cousin.id);
    const maman = accounts.find((m) => m.userId === f.maman.id);
    expect((await as(f.papa).put("/api/family-memberships").send({ id: cousin.id, role: "adult", linkedMemberId: x.body.id })).status).toBe(200);
    expect((await texts(f.papa, "&category=espace"))[0]).toBe("Mouhamed Fall a relié le compte de Cousin Fall à la fiche de Ibou Fall");
    expect((await texts(f.papa, "&category=roles"))[0]).toBe(
      "Rôles retirés sur le dossier de Ibou Fall, désormais tenu par son titulaire : Mouhamed Fall (gestionnaire), Omar Fall (relais)"
    );
    expect((await as(f.papa).delete(`/api/family-memberships?id=${maman.id}`)).status).toBe(200);
    expect((await as(f.papa).put("/api/family-memberships").send({ id: cousin.id, role: "parent" })).status).toBe(200);
    expect((await texts(f.papa, "&category=espace"))[0]).toBe("Mouhamed Fall a nommé Cousin Fall co-administrateur");
    // Devenu parent, sa fiche relève de la réciprocité : A1 n'en voit plus l'activité.
    expect(await texts(f.papa)).not.toContain("Mouhamed Fall a relié le compte de Cousin Fall à la fiche de Ibou Fall");
  });

  it("« Ma fiche » : désigner une fiche que l'on gère comme la sienne", async () => {
    const x = await as(f.cousin)
      .post("/api/members")
      .send({ familyId: f.family.id, firstName: "Cousin", lastName: "Fall", dateOfBirth: "1990-01-01", gender: "M", kinship: "cousin", consent: attestation(f.cousin) });
    expect((await as(f.cousin).post("/api/members/claim").send({ id: x.body.id })).status).toBe(200);
    expect(await texts(f.cousin)).toEqual([
      "Cousin Fall a désigné la fiche de Cousin Fall comme la sienne",
      expect.stringMatching(/^Cousin Fall a attesté l'accord oral de Cousin Fall \(en personne, accord du \d{2}\/\d{2}\/\d{4}\)$/),
      "Cousin Fall a créé la fiche de Cousin Fall et en est gestionnaire",
    ]);
  });

  it("aucune donnée médicale dans les textes : document confidentiel sans son titre", async () => {
    const up = await as(f.medoune)
      .post("/api/documents")
      .field("memberId", String(f.fMedoune.id))
      .field("title", "Analyse sérologie secrète")
      .field("documentType", "analyse")
      .field("isConfidential", "true");
    expect(up.status).toBe(201);
    await as(f.medoune)
      .put("/api/documents")
      .send({ id: up.body.id, title: "Analyse sérologie secrète", documentType: "analyse", isConfidential: false });
    const body = await journal(f.medoune, "&category=documents");
    expect(body.entries.map((e) => e.text)).toEqual([
      "Medoune Fall a levé la confidentialité d'un document du dossier de Medoune Fall",
      "Medoune Fall a ajouté un document confidentiel au dossier de Medoune Fall",
    ]);
    expect(JSON.stringify(body)).not.toMatch(/sérologie|analyse/i);
  });
});

describe("Journal — qui voit quoi", () => {
  it("réciprocité des parents : A1 ne voit pas l'activité sur la fiche de A2, ni A2 sur celle de A1", async () => {
    expect((await share(f.maman, f.fMaman.id)).status).toBe(201);
    expect((await share(f.papa, f.fPapa.id)).status).toBe(201);
    const papa = await journal(f.papa);
    const maman = await journal(f.maman);
    expect(papa.scope).toBe("family");
    expect(papa.entries.map((e) => e.memberId)).toEqual([f.fPapa.id]);
    expect(maman.entries.map((e) => e.memberId)).toEqual([f.fMaman.id]);
    // Filtrer explicitement sur la fiche de l'autre parent ne donne rien.
    expect((await journal(f.papa, `&memberId=${f.fMaman.id}`)).entries).toHaveLength(0);
    expect(papa.members.map((m) => m.id)).not.toContain(f.fMaman.id);
  });

  it("un adulte ne voit que l'activité sur son dossier ; un relais ou gestionnaire rien d'autre", async () => {
    await share(f.medoune, f.fMedoune.id);
    await as(f.papa).post("/api/document-roles").send({ memberId: f.fMamie.id, userId: f.medoune.id, role: "lecteur_invite" });
    await as(f.papa).post("/api/invitations").send({ familyId: f.family.id, email: "x@test.local", role: "member" });
    const medoune = await journal(f.medoune);
    expect(medoune.scope).toBe("mine");
    expect(medoune.entries.map((e) => e.action)).toEqual(["doctor_share_sent"]);
    expect(medoune.members).toEqual([{ id: f.fMedoune.id, name: "Medoune Fall" }]);
    // Gestionnaire et relais de Mamie, sans fiche à eux : rien.
    expect((await journal(f.cousin)).entries).toHaveLength(0);
    expect((await journal(f.omar)).entries).toHaveLength(0);
    // Les parents voient tout cela.
    expect(await actions(f.papa)).toEqual(["invitation_sent", "document_role_granted", "doctor_share_sent"]);
  });

  it("une adolescente voit l'activité sur sa propre fiche, en lecture seule", async () => {
    await as(f.papa).put(`/api/emergency/${f.fToutou.id}`).send({ active: true, fields: { showAge: true } });
    await share(f.medoune, f.fMedoune.id);
    const toutou = await journal(f.toutou);
    expect(toutou.scope).toBe("mine");
    expect(toutou.entries.map((e) => e.text)).toEqual([
      "Mouhamed Fall a activé la fiche d'urgence de Toutou Fall — informations publiées : âge",
    ]);
  });

  it("fiche archivée : ses événements sont masqués aux parents, sauf l'archivage lui-même", async () => {
    await share(f.medoune, f.fMedoune.id);
    expect((await as(f.papa).delete(`/api/family-memberships?id=${f.sm.id}`)).status).toBe(200);
    const list = await journal(f.papa);
    expect(list.entries.map((e) => e.action)).toEqual(["account_removed", "member_archived"]);
    expect(list.entries.map((e) => e.text)).toEqual([
      "Mouhamed Fall a retiré Medoune Fall de l'espace familial",
      "La fiche de Medoune Fall a été archivée : Medoune Fall a quitté la famille (retiré par Mouhamed Fall)",
    ]);
  });

  it("l'archivage de la fiche de l'autre parent reste visible ; pas le reste de son activité", async () => {
    await share(f.maman, f.fMaman.id);
    const [mm] = await db.select().from(users).where(eq(users.id, f.maman.id));
    expect(mm).toBeTruthy();
    const membership = (await as(f.papa).get(`/api/family-memberships?familyId=${f.family.id}`)).body.find((m) => m.userId === f.maman.id);
    expect((await as(f.papa).delete(`/api/family-memberships?id=${membership.id}`)).status).toBe(200);
    expect(await actions(f.papa)).toEqual(["account_removed", "member_archived"]);
  });

  it("un compte d'une autre famille n'a pas accès au journal", async () => {
    const other = await createUser("Intrus");
    await addMembership(other, await createFamily("Autre"), "parent", { isPrimaryAdmin: true });
    expect((await as(other).get(`/api/activity?familyId=${f.family.id}`)).status).toBe(403);
  });

  it("pagination par curseur et filtres invalides", async () => {
    for (let i = 0; i < 3; i++) await as(f.papa).post("/api/invitations").send({ familyId: f.family.id, email: `p${i}@test.local`, role: "member" });
    const first = await journal(f.papa, "&limit=2");
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await journal(f.papa, `&limit=2&before=${encodeURIComponent(first.nextCursor)}`);
    expect(second.entries).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.entries[0].text).toContain("p0@test.local");
    expect((await as(f.papa).get(`/api/activity?familyId=${f.family.id}&category=inconnue`)).status).toBe(400);
    expect((await as(f.papa).get(`/api/activity?familyId=${f.family.id}&before=n-importe-quoi`)).status).toBe(400);
    // Période : rien demain.
    const tomorrow = new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10);
    expect((await journal(f.papa, `&from=${tomorrow}`)).entries).toHaveLength(0);
  });
});

describe("Journal — conservation", () => {
  it("une entrée ne peut être ni modifiée ni supprimée directement en base", async () => {
    await as(f.papa).post("/api/invitations").send({ familyId: f.family.id, email: "x@test.local", role: "member" });
    await expect(db.execute(sql`update activity_log set action = 'falsifie'`)).rejects.toThrow();
    await expect(db.execute(sql`update activity_log set actor_name = 'Autre'`)).rejects.toThrow();
    await expect(db.execute(sql`delete from activity_log`)).rejects.toThrow();
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });

  it("supprimer la famille supprime son journal", async () => {
    await as(f.papa).post("/api/invitations").send({ familyId: f.family.id, email: "x@test.local", role: "member" });
    expect((await as(f.papa).delete(`/api/families?id=${f.family.id}`)).status).toBe(200);
    expect(await db.select().from(families)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("un compte supprimé reste nommé, suivi de « (compte supprimé) »", async () => {
    await share(f.medoune, f.fMedoune.id);
    const del = await as(f.medoune).delete("/api/account").send({ password: PASSWORD });
    expect(del.status).toBe(200);
    const list = await texts(f.papa);
    expect(list).toEqual([
      "La fiche de Medoune Fall a été archivée : Medoune Fall (compte supprimé) a quitté la famille",
      "Medoune Fall (compte supprimé) a quitté l'espace familial en supprimant son compte",
    ]);
    // L'identifiant du compte est effacé, le nom conservé.
    const rows = await db.select().from(activityLog).where(eq(activityLog.action, "account_deleted"));
    expect(rows[0]).toMatchObject({ actorUserId: null, actorName: "Medoune Fall" });
  });

  it("création de l'espace familial", async () => {
    const awa = await createUser("Awa Diop");
    const res = await as(awa).post("/api/families").send({ name: "Diop" });
    const r = await as(awa).get(`/api/activity?familyId=${res.body.id}`);
    expect(r.body.entries.map((e) => e.text)).toEqual(["Awa Diop a créé l'espace familial « Diop »"]);
  });
});
