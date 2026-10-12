import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import { doctorShares, documents, emergencyCardViews, members, notifications, treatmentMedications, treatments, vaccinations } from "../src/db/schema.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, grantRole, as } from "./helpers.js";
import { buildDoctorShareEmail, sendDoctorShareEmail } from "../src/lib/mailer.js";

// Le lien médecin ne part que par courriel : l'envoi est intercepté pour
// récupérer le lien comme le ferait le médecin.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendDoctorShareEmail: vi.fn(async () => {}),
}));

// Phase F : lien médecin à usage unique et fiche d'urgence.
let f;
beforeEach(async () => {
  vi.mocked(sendDoctorShareEmail).mockClear();
  await resetDatabase();
  const family = await createFamily("Fall");
  const [papa, maman, medoune, toutou, cousin] = await Promise.all(
    ["Mouhamed", "Dior", "Medoune", "Toutou", "Cousin"].map((n) => createUser(n))
  );
  const pm = await addMembership(papa, family, "parent", { isPrimaryAdmin: true });
  const mm = await addMembership(maman, family, "parent");
  const sm = await addMembership(medoune, family, "adult");
  const tm = await addMembership(toutou, family, "adult");
  await addMembership(cousin, family, "adult");
  const fiche = async (firstName, data, membership) => {
    const m = await createMember(family, firstName);
    await db.update(members).set(data).where(eq(members.id, m.id));
    if (membership) await linkMember(membership, m);
    return { ...m, ...data };
  };
  const fPapa = await fiche("Mouhamed", { dateOfBirth: "1966-12-11" }, pm);
  const fMaman = await fiche("Dior", { dateOfBirth: "1976-04-22" }, mm);
  const fMedoune = await fiche(
    "Medoune",
    {
      dateOfBirth: "2004-06-10",
      bloodType: "O+",
      allergies: "Pénicilline",
      doctorName: "Dr Ndiaye",
      emergencyContactName: "Dior Fall",
      emergencyContactPhone: "+221770000000",
      notes: "Note privée",
    },
    sm
  );
  const fToutou = await fiche("Toutou", { dateOfBirth: "2011-08-25" }, tm); // 15 ans : adolescente
  const fMamie = await fiche("Mamie", { dateOfBirth: "1940-01-01", allergies: "Aspirine" }); // sans compte
  await grantRole(fMamie, cousin, "gestionnaire");
  f = { family, papa, maman, medoune, toutou, cousin, fPapa, fMaman, fMedoune, fToutou, fMamie };
});

const notifsOf = async (user, category) =>
  (await db.select().from(notifications).where(eq(notifications.userId, user.id))).filter((n) => !category || n.category === category);

const DOCTOR = "dr.ndiaye@clinique.sn";
const createShare = (user, body) => as(user).post("/api/doctor-shares").send({ doctorEmail: DOCTOR, ...body });
// Jeton du dernier lien envoyé par courriel.
const sentToken = () => vi.mocked(sendDoctorShareEmail).mock.lastCall[0].link.split("/medecin/")[1];

describe("Lien médecin — création", () => {
  it("titulaire, parent et gestionnaire peuvent créer ; pas l'adolescente ni un autre adulte", async () => {
    expect((await createShare(f.medoune, { memberId: f.fMedoune.id })).status).toBe(201);
    expect((await createShare(f.papa, { memberId: f.fMedoune.id })).status).toBe(201);
    expect((await createShare(f.cousin, { memberId: f.fMamie.id })).status).toBe(201);
    expect((await createShare(f.toutou, { memberId: f.fToutou.id })).status).toBe(403);
    expect((await createShare(f.medoune, { memberId: f.fMamie.id })).status).toBe(403);
    // Règle §10 : un parent ne partage pas la fiche de l'autre parent.
    expect((await createShare(f.papa, { memberId: f.fMaman.id })).status).toBe(403);
  });

  it("le lien part par courriel au médecin et n'est jamais renvoyé à la famille", async () => {
    const res = await createShare(f.papa, { memberId: f.fMedoune.id, doctorEmail: "  Dr.Ndiaye@Clinique.SN " });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("url");
    expect(res.body.doctorEmail).toBe(DOCTOR);
    expect(JSON.stringify(res.body)).not.toContain(sentToken());
    const mail = vi.mocked(sendDoctorShareEmail).mock.lastCall[0];
    expect(mail).toMatchObject({ to: DOCTOR, memberName: "Medoune Test", senderName: "Mouhamed" });
    expect((await as(f.papa).get(`/api/doctor-shares?memberId=${f.fMedoune.id}`)).body[0].doctorEmail).toBe(DOCTOR);
  });

  it("adresse du médecin absente ou invalide : refusé, rien n'est envoyé", async () => {
    expect((await createShare(f.papa, { memberId: f.fMedoune.id, doctorEmail: "" })).status).toBe(400);
    expect((await createShare(f.papa, { memberId: f.fMedoune.id, doctorEmail: "pas-une-adresse" })).status).toBe(400);
    expect(sendDoctorShareEmail).not.toHaveBeenCalled();
    expect(await db.select().from(doctorShares)).toHaveLength(0);
  });

  it("courriel non envoyé : le lien est supprimé et la famille est prévenue", async () => {
    vi.mocked(sendDoctorShareEmail).mockRejectedValueOnce(new Error("SMTP indisponible"));
    const res = await createShare(f.papa, { memberId: f.fMedoune.id });
    expect(res.status).toBe(502);
    expect(await db.select().from(doctorShares)).toHaveLength(0);
    expect(await notifsOf(f.medoune, "doctor_share")).toHaveLength(0);
  });

  it("courriel : bouton d'accès, nom du patient échappé", () => {
    const mail = buildDoctorShareEmail({
      link: "https://app/medecin/abc",
      memberName: "<b>Medoune</b> Fall",
      senderName: "Mouhamed",
      expiresAtLabel: "13/10/2026 à 10:00",
    });
    expect(mail.html).toContain('href="https://app/medecin/abc"');
    expect(mail.html).toContain("Consulter le dossier");
    expect(mail.html).toContain("13/10/2026 à 10:00");
    expect(mail.html).not.toContain("<b>Medoune</b>");
  });

  it("durées 2 h, 24 h, 7 j ; le titulaire est prévenu ; seule l'empreinte est stockée", async () => {
    const res = await createShare(f.papa, { memberId: f.fMedoune.id, duration: "24h" });
    expect(res.body.state).toBe("pending");
    const hours = (new Date(res.body.expiresAt) - Date.now()) / 3600e3;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    expect((await createShare(f.papa, { memberId: f.fMedoune.id, duration: "1an" })).status).toBe(400);
    const [row] = await db.select().from(doctorShares);
    expect(row.tokenHash).not.toBe(sentToken());
    const n = await notifsOf(f.medoune, "doctor_share");
    expect(n[0].title).toContain("Lien médecin envoyé");
    expect(n[0].body).toContain(DOCTOR);
  });

  it("pour un proche sans compte, ce sont ses gestionnaires qui sont prévenus", async () => {
    await createShare(f.cousin, { memberId: f.fMamie.id });
    expect(await notifsOf(f.cousin, "doctor_share")).toHaveLength(1);
  });

  it("un document confidentiel d'un autre ne peut pas être partagé", async () => {
    const [doc] = await db
      .insert(documents)
      .values({ memberId: f.fMedoune.id, title: "Secret", documentType: "autre", isConfidential: true })
      .returning();
    expect((await createShare(f.maman, { memberId: f.fMedoune.id, documentIds: [doc.id] })).status).toBe(400);
    expect((await createShare(f.medoune, { memberId: f.fMedoune.id, documentIds: [doc.id] })).status).toBe(201);
  });
});

describe("Lien médecin — ouverture à usage unique", () => {
  it("la première ouverture lie le lien à l'appareil ; un autre appareil est refusé et signalé", async () => {
    const [t] = await db.insert(treatments).values({ memberId: f.fMedoune.id, disease: "Asthme", isActive: true }).returning();
    await db.insert(treatmentMedications).values({ treatmentId: t.id, name: "Ventoline" });
    await db.insert(vaccinations).values({ memberId: f.fMedoune.id, vaccineName: "BCG", dateAdministered: "2005-01-01" });
    await createShare(f.papa, { memberId: f.fMedoune.id, includeTreatments: true });
    const token = sentToken();

    const medecin = request.agent(app);
    const first = await medecin.get(`/api/public/doctor/${token}`);
    expect(first.status).toBe(200);
    expect(first.body.essentials).toMatchObject({ bloodType: "O+", allergies: "Pénicilline" });
    expect(first.body.treatments[0]).toMatchObject({ disease: "Asthme", medications: [{ name: "Ventoline" }] });
    expect(first.body).not.toHaveProperty("vaccinations"); // non coché
    expect(JSON.stringify(first.body)).not.toContain("Note privée");

    // Même appareil : relire fonctionne.
    expect((await medecin.get(`/api/public/doctor/${token}`)).status).toBe(200);
    // Autre appareil : refusé.
    const other = await request(app).get(`/api/public/doctor/${token}`);
    expect(other.status).toBe(410);
    expect(other.body.reason).toBe("already_opened");
    const titles = (await notifsOf(f.medoune, "doctor_share")).map((n) => n.title);
    expect(titles.some((x) => x.includes("a été ouvert"))).toBe(true);
    expect(titles.some((x) => x.includes("Ouverture refusée"))).toBe(true);
  });

  it("révocation : le médecin perd l'accès immédiatement, le titulaire est prévenu", async () => {
    const { body } = await createShare(f.medoune, { memberId: f.fMedoune.id });
    const medecin = request.agent(app);
    const token = sentToken();
    expect((await medecin.get(`/api/public/doctor/${token}`)).status).toBe(200);
    expect((await as(f.toutou).post(`/api/doctor-shares/${body.id}/revoke`)).status).toBe(403);
    expect((await as(f.medoune).post(`/api/doctor-shares/${body.id}/revoke`)).body.state).toBe("revoked");
    const after = await medecin.get(`/api/public/doctor/${token}`);
    expect(after.status).toBe(410);
    expect(after.body.reason).toBe("revoked");
    const titles = (await notifsOf(f.medoune, "doctor_share")).map((n) => n.title);
    expect(titles.some((x) => x.includes("révoqué"))).toBe(true);
  });

  it("expiration et lien inconnu", async () => {
    await createShare(f.medoune, { memberId: f.fMedoune.id });
    await db.update(doctorShares).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await request(app).get(`/api/public/doctor/${sentToken()}`)).body.reason).toBe("expired");
    expect((await request(app).get(`/api/public/doctor/inconnu`)).status).toBe(404);
  });

  it("liste des partages réservée à qui peut les gérer", async () => {
    await createShare(f.medoune, { memberId: f.fMedoune.id });
    const list = await as(f.papa).get(`/api/doctor-shares?memberId=${f.fMedoune.id}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).not.toHaveProperty("url");
    expect((await as(f.toutou).get(`/api/doctor-shares?memberId=${f.fMedoune.id}`)).status).toBe(403);
  });
});

describe("Fiche d'urgence", () => {
  const put = (user, member, body) => as(user).put(`/api/emergency/${member.id}`).send(body);

  it("rien n'est publié par défaut", async () => {
    const res = await as(f.medoune).get(`/api/emergency/${f.fMedoune.id}`);
    expect(res.body).toMatchObject({ active: false, canEdit: true, url: null, preview: null });
    expect(Object.values(res.body.fields).every((v) => v === false)).toBe(true);
  });

  it("seul le titulaire compose sa fiche ; pour un proche sans compte, son gestionnaire", async () => {
    expect((await put(f.papa, f.fMedoune, { active: true, fields: { showBloodType: true } })).status).toBe(403);
    expect((await put(f.cousin, f.fMamie, { active: true, fields: { showAllergies: true } })).status).toBe(200);
    // Adolescente : lecture seule, ses parents composent pour elle.
    expect((await put(f.toutou, f.fToutou, { active: true, fields: { showAge: true } })).status).toBe(403);
    expect((await put(f.papa, f.fToutou, { active: true, fields: { showAge: true } })).status).toBe(200);
  });

  it("n'affiche que les champs cochés, journalise et prévient le titulaire", async () => {
    await db.insert(documents).values({ memberId: f.fMedoune.id, title: "Radio", documentType: "imagerie" });
    const res = await put(f.medoune, f.fMedoune, { active: true, fields: { showBloodType: true, showEmergencyContact: true } });
    expect(res.body.preview).toMatchObject({ firstName: "Medoune", bloodType: "O+", emergencyContact: { phone: "+221770000000" } });
    const token = res.body.url.split("/urgence/")[1];

    const pub = await request(app).get(`/api/public/emergency/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body).toEqual(res.body.preview);
    const text = JSON.stringify(pub.body);
    for (const hidden of ["Pénicilline", "Dr Ndiaye", "Note privée", "Radio", "2004"]) expect(text).not.toContain(hidden);

    expect(await db.select().from(emergencyCardViews)).toHaveLength(1);
    expect((await notifsOf(f.medoune, "emergency_view"))[0].title).toContain("consultée");
  });

  it("désactivée ou régénérée : l'ancien QR code ne fonctionne plus", async () => {
    const res = await put(f.medoune, f.fMedoune, { active: true, fields: { showBloodType: true } });
    const oldToken = res.body.url.split("/urgence/")[1];
    const regen = await as(f.medoune).post(`/api/emergency/${f.fMedoune.id}/regenerate`);
    const newToken = regen.body.url.split("/urgence/")[1];
    expect(newToken).not.toBe(oldToken);
    expect((await request(app).get(`/api/public/emergency/${oldToken}`)).status).toBe(404);
    expect((await request(app).get(`/api/public/emergency/${newToken}`)).status).toBe(200);
    await put(f.medoune, f.fMedoune, { active: false, fields: { showBloodType: true } });
    expect((await request(app).get(`/api/public/emergency/${newToken}`)).status).toBe(404);
  });

  it("activer sans rien cocher est refusé", async () => {
    expect((await put(f.medoune, f.fMedoune, { active: true, fields: {} })).status).toBe(400);
  });

  it("un lecteur ne voit pas le lien du QR code", async () => {
    await put(f.medoune, f.fMedoune, { active: true, fields: { showBloodType: true } });
    const res = await as(f.papa).get(`/api/emergency/${f.fMedoune.id}`);
    expect(res.body).toMatchObject({ canEdit: false, url: null, active: true });
  });
});
