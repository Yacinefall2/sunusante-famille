import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import {
  activityLog,
  appointments,
  documentRoles,
  documents,
  familyExports,
  medicationIntakes,
  members,
  notifications,
  treatmentMedications,
  treatments,
  users,
  vaccinations,
} from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { UPLOAD_DIR_PATH } from "../src/middleware/upload.js";
import { sendFamilyExportEmail } from "../src/lib/mailer.js";
import { EXPORT_DIR, exportsTick, prepareFamilyExport } from "../src/lib/familyExport.js";
import { dateTimeLabel, dayLabel, slugify } from "../src/lib/medicalRecordPdf.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, grantRole, as } from "./helpers.js";

// Exports (UC-27 dossier médical en PDF, UC-09 archive ZIP de la famille) :
// droits, contenu, usage unique du lien, expiration, information de l'autre parent.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendFamilyExportEmail: vi.fn(async () => {}),
}));

const PASSWORD = "Mon-mdp-123";
const HOUR = 60 * 60 * 1000;

// ── Lecture d'un PDF : texte des flux (polices standard, encodage WinAnsi) ───
const WIN_ANSI = { 0x80: "€", 0x8c: "Œ", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x9c: "œ" };
function pdfText(buffer) {
  const raw = buffer.toString("latin1");
  const out = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content;
    try {
      content = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      content = m[1];
    }
    for (const tj of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      const text = [...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)]
        .map((h) => [...Buffer.from(h[1], "hex")].map((b) => WIN_ANSI[b] ?? String.fromCharCode(b)).join(""))
        .join("");
      out.push(text);
    }
  }
  return out.join("\n");
}

// ── Lecture d'un ZIP : répertoire central, puis contenu d'une entrée ─────────
function zipEntries(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLength);
    entries.set(name, () => {
      const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(start, start + compressedSize);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const binary = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};
const getBinary = (user, url) => as(user).get(url).buffer(true).parse(binary);

async function userWithPassword(name) {
  const [u] = await db
    .insert(users)
    .values({ email: `${slugify(name).toLowerCase()}@test.local`, passwordHash: await hashPassword(PASSWORD), name, emailVerified: true })
    .returning();
  return u;
}

// Fichier de document sur le disque (effacé après chaque test).
const createdFiles = [];
function storedFile(content = "%PDF-1.4 contenu de test") {
  const name = `${crypto.randomUUID()}.pdf`;
  fs.writeFileSync(path.join(UPLOAD_DIR_PATH, name), content);
  createdFiles.push(path.join(UPLOAD_DIR_PATH, name));
  return `/uploads/${name}`;
}

// Foyer Fall : Mouhamed (A1) et Awa (A2), chacun sa fiche ; Moussa (adulte,
// sa fiche, gestionnaire de Fatou) ; Toutou (adolescente, sa fiche) ; Fatou
// (proche sans compte) avec une lectrice invitée (Khady) et un relais (Omar).
let f;
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  const family = await createFamily("Fall");
  const papa = await userWithPassword("Mouhamed Fall");
  const maman = await userWithPassword("Awa Fall");
  const [moussa, toutou, khady, omar, intrus] = await Promise.all(
    ["Moussa Fall", "Toutou Fall", "Khady Ndiaye", "Omar Fall", "Intrus Diop"].map((n) => createUser(n))
  );
  const pm = await addMembership(papa, family, "parent", { isPrimaryAdmin: true });
  const mm = await addMembership(maman, family, "parent");
  const sm = await addMembership(moussa, family, "adult");
  const tm = await addMembership(toutou, family, "adult");
  await addMembership(khady, family, "adult");
  await addMembership(omar, family, "adult");
  const autre = await createFamily("Diop");
  await addMembership(intrus, autre, "parent", { isPrimaryAdmin: true });

  const fiche = async (firstName, data = {}, membership = null) => {
    const m = await createMember(family, firstName);
    await db.update(members).set({ lastName: "Fall", ...data }).where(eq(members.id, m.id));
    if (membership) await linkMember(membership, m);
    return { ...m, lastName: "Fall", ...data };
  };
  const fPapa = await fiche("Mouhamed", { dateOfBirth: "1966-12-11", gender: "M" }, pm);
  const fMaman = await fiche("Awa", { dateOfBirth: "1976-04-22", gender: "F", allergies: "Allergie secrète d'Awa" }, mm);
  const fMoussa = await fiche("Moussa", { dateOfBirth: "2000-06-10" }, sm);
  const fToutou = await fiche("Toutou", { dateOfBirth: "2011-08-25" }, tm);
  const fFatou = await fiche("Fatou", {
    dateOfBirth: "1950-02-03",
    gender: "F",
    bloodType: "B+",
    allergies: "Pénicilline",
    notes: "Hypertension suivie — œdème des chevilles",
    doctorName: "Dr Sène",
    doctorPhone: "+221 77 000 00 00",
    emergencyContactName: "Moussa Fall",
    emergencyContactRelation: "petit-fils",
    emergencyContactPhone: "+221 78 000 00 00",
    status: "non_connecte",
  });
  await grantRole(fFatou, moussa, "gestionnaire");
  await grantRole(fFatou, omar, "relais");
  await grantRole(fFatou, khady, "lecteur_invite");
  // Accès de lectrice invitée encore valable une semaine.
  await db.update(documentRoles).set({ expiresAt: new Date(Date.now() + 7 * 24 * HOUR) }).where(eq(documentRoles.userId, khady.id));

  // Dossier de Fatou : traitement en cours avec prises, traitement terminé,
  // vaccin avec rappel, rendez-vous passé et à venir, documents.
  const [t] = await db
    .insert(treatments)
    .values({ memberId: fFatou.id, disease: "Hypertension artérielle", startDate: "2026-01-05", prescribedBy: "Dr Sène" })
    .returning();
  const [med] = await db
    .insert(treatmentMedications)
    .values({ treatmentId: t.id, name: "Amlodipine", dosage: "5 mg", frequency: "1 fois par jour", intakeTimes: ["08:00"] })
    .returning();
  for (const [i, status] of ["taken", "taken", "taken", "not_taken"].entries()) {
    await db.insert(medicationIntakes).values({ medicationId: med.id, memberId: fFatou.id, scheduledAt: new Date(Date.now() - (i + 1) * 24 * HOUR), status });
  }
  const [old] = await db
    .insert(treatments)
    .values({ memberId: fFatou.id, disease: "Angine", startDate: "2025-03-01", endDate: "2025-03-10", isActive: false })
    .returning();
  await db.insert(treatmentMedications).values({ treatmentId: old.id, name: "Amoxicilline", dosage: "1 g" });
  await db.insert(vaccinations).values({ memberId: fFatou.id, vaccineName: "Grippe saisonnière", dateAdministered: "2025-10-01", nextDoseDate: "2026-01-01", administeredBy: "Poste de santé", lotNumber: "LOT-42" });
  await db.insert(appointments).values([
    { memberId: fFatou.id, title: "Consultation cardiologie", doctorName: "Dr Ba", location: "Hôpital Principal", appointmentDate: new Date(Date.now() + 5 * 24 * HOUR), status: "confirmed" },
    { memberId: fFatou.id, title: "Bilan sanguin", location: "Laboratoire", appointmentDate: new Date(Date.now() - 10 * 24 * HOUR), status: "confirmed", attendance: "attended" },
  ]);
  const [docOk] = await db
    .insert(documents)
    .values({ memberId: fFatou.id, title: "Ordonnance Amlodipine", documentType: "ordonnance", fileUrl: storedFile(), originalName: "ordo.pdf", uploadedByUserId: moussa.id })
    .returning();
  const [docSecret] = await db
    .insert(documents)
    .values({ memberId: fFatou.id, title: "Résultat confidentiel", documentType: "resultat", fileUrl: storedFile(), isConfidential: true })
    .returning();
  await db.insert(documents).values({ memberId: fMaman.id, title: "Document privé d'Awa", documentType: "autre", fileUrl: storedFile() });

  f = { family, autre, papa, maman, moussa, toutou, khady, omar, intrus, fPapa, fMaman, fMoussa, fToutou, fFatou, docOk, docSecret };
});

afterEach(() => {
  for (const p of createdFiles.splice(0)) fs.rmSync(p, { force: true });
  fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
});

const pdfOf = (user, member) => getBinary(user, `/api/members/${member.id}/export.pdf`);

describe("UC-27 — dossier médical en PDF", () => {
  it("un PDF A4 paginé, au nom de la personne, avec tout le dossier", async () => {
    const res = await pdfOf(f.papa, f.fFatou);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="dossier-fatou-fall-\d{4}-\d{2}-\d{2}\.pdf"/);
    expect(res.body.subarray(0, 4).toString()).toBe("%PDF");
    const text = pdfText(res.body);
    expect(text).toContain("SunuSanté Famille — Dossier médical de Fatou Fall");
    expect(text).toContain("Document confidentiel — exporté le");
    expect(text).toContain("par Mouhamed Fall — page 1/");
    expect(text).toContain("03/02/1950");
    expect(text).toContain("Pénicilline");
    expect(text).toContain("Hypertension suivie — œdème des chevilles");
    expect(text).toContain("Hypertension artérielle");
    expect(text).toContain("Amlodipine · 5 mg · 1 fois par jour · à 08:00");
    expect(text).toContain("Observance sur 30 jours : 75 %");
    expect(text).toContain("Angine");
    expect(text).toContain("Rappel : 01/01/2026 (en retard)");
    expect(text).toContain("Lot : LOT-42");
    expect(text).toContain("Consultation cardiologie");
    expect(text).toContain("Présence : s'y est rendu(e)");
    expect(text).toContain("Ordonnance Amlodipine");
    // A1 voit les documents confidentiels des dossiers qu'il lit.
    expect(text).toContain("Résultat confidentiel");
  });

  it("sections vides : « Aucun … enregistré »", async () => {
    const text = pdfText((await pdfOf(f.papa, f.fPapa)).body);
    expect(text).toContain("Aucun traitement en cours enregistré");
    expect(text).toContain("Aucune vaccination enregistrée");
    expect(text).toContain("Aucun rendez-vous à venir enregistré");
    expect(text).toContain("Aucun document enregistré");
  });

  it("gestionnaire, co-administratrice, lectrice invitée : oui — sans les documents confidentiels d'autrui", async () => {
    for (const user of [f.moussa, f.maman, f.khady]) {
      const res = await pdfOf(user, f.fFatou);
      expect(res.status).toBe(200);
      const text = pdfText(res.body);
      expect(text).toContain("Dossier médical de Fatou Fall");
      expect(text).toContain("Ordonnance Amlodipine");
      expect(text).not.toContain("Résultat confidentiel");
    }
  });

  it("titulaire et adolescente sur leur propre fiche : oui", async () => {
    expect((await pdfOf(f.moussa, f.fMoussa)).status).toBe(200);
    expect((await pdfOf(f.toutou, f.fToutou)).status).toBe(200);
  });

  it("relais, autre famille, adolescente sur une autre fiche, fiche de l'autre parent, fiche archivée : refusé", async () => {
    expect((await pdfOf(f.omar, f.fFatou)).status).toBe(403);
    expect((await pdfOf(f.intrus, f.fFatou)).status).toBe(403);
    expect((await pdfOf(f.toutou, f.fFatou)).status).toBe(403);
    expect((await pdfOf(f.papa, f.fMaman)).status).toBe(403);
    expect((await pdfOf(f.maman, f.fPapa)).status).toBe(403);
    await db.update(members).set({ archivedAt: new Date(), archivedReason: "departure" }).where(eq(members.id, f.fMoussa.id));
    expect((await pdfOf(f.papa, f.fMoussa)).status).toBe(403);
    expect((await pdfOf(f.moussa, f.fMoussa)).status).toBe(403);
  });

  it("lectrice invitée dont l'accès a expiré : refusé", async () => {
    await db.update(documentRoles).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(documentRoles.userId, f.khady.id));
    expect((await pdfOf(f.khady, f.fFatou)).status).toBe(403);
  });

  it("l'export est tracé au journal (catégorie « Exports »), visible selon les règles habituelles", async () => {
    await pdfOf(f.khady, f.fFatou);
    const [entry] = await db.select().from(activityLog).where(eq(activityLog.action, "member_exported_pdf"));
    expect(entry.memberId).toBe(f.fFatou.id);
    const papa = await as(f.papa).get(`/api/activity?familyId=${f.family.id}&category=exports`);
    expect(papa.body.categories.exports).toBe("Exports");
    expect(papa.body.entries.map((e) => e.text)).toContain("Khady Ndiaye a exporté en PDF le dossier de Fatou Fall");
    // Un adulte ne voit que l'activité de sa propre fiche.
    const moussa = await as(f.moussa).get(`/api/activity?familyId=${f.family.id}&category=exports`);
    expect(moussa.body.entries).toHaveLength(0);
  });
});

// ── UC-09 ─────────────────────────────────────────────────────────────────────

const requestExport = (user, body = { password: PASSWORD, acknowledged: true }, familyId = f.family.id) =>
  as(user).post(`/api/families/${familyId}/export`).send(body);
const lastToken = () => vi.mocked(sendFamilyExportEmail).mock.lastCall[0].token;
const download = (user, token) => getBinary(user, `/api/exports/${token}/download`);

async function readyExport(user = f.papa) {
  const res = await requestExport(user);
  expect(res.status).toBe(202);
  const ready = await prepareFamilyExport(res.body.export.id);
  expect(ready.status).toBe("ready");
  return { id: res.body.export.id, token: lastToken() };
}

describe("UC-09 — demande d'export de la famille", () => {
  it("réservée aux parents", async () => {
    expect((await requestExport(f.moussa)).status).toBe(403);
    expect((await requestExport(f.toutou)).status).toBe(403);
    expect((await requestExport(f.intrus)).status).toBe(403);
  });

  it("mot de passe exigé, avec la limite de tentatives de la connexion ; case de confirmation obligatoire", async () => {
    expect((await requestExport(f.papa, { password: PASSWORD })).status).toBe(400);
    for (let i = 0; i < 4; i += 1) expect((await requestExport(f.papa, { password: "faux", acknowledged: true })).status).toBe(403);
    expect((await requestExport(f.papa, { password: "faux", acknowledged: true })).status).toBe(403);
    // Bloqué, même avec le bon mot de passe.
    expect((await requestExport(f.papa)).status).toBe(429);
    expect(await db.select().from(familyExports)).toHaveLength(0);
  });

  it("202 immédiat, une seule demande en préparation, journal", async () => {
    const res = await requestExport(f.papa);
    expect(res.status).toBe(202);
    expect(res.body.message).toContain("en préparation");
    expect(res.body.export.status).toBe("pending");
    expect((await requestExport(f.papa)).status).toBe(409);
    // L'autre parent peut demander la sienne en parallèle.
    expect((await requestExport(f.maman)).status).toBe(202);
    const history = await as(f.papa).get(`/api/families/${f.family.id}/exports`);
    expect(history.body.exports).toHaveLength(1);
    expect(history.body.exports[0]).not.toHaveProperty("tokenHash");
    const logged = await db.select().from(activityLog).where(eq(activityLog.action, "family_export_requested"));
    expect(logged).toHaveLength(2);
  });

  it("au plus 3 exports par 24 heures", async () => {
    await db.insert(familyExports).values([
      { familyId: f.family.id, requestedByUserId: f.papa.id, status: "downloaded" },
      { familyId: f.family.id, requestedByUserId: f.papa.id, status: "expired" },
      { familyId: f.family.id, requestedByUserId: f.papa.id, status: "downloaded" },
    ]);
    expect((await requestExport(f.papa)).status).toBe(429);
    // Une demande en échec ne compte pas.
    await db.update(familyExports).set({ status: "failed" }).where(eq(familyExports.status, "expired"));
    expect((await requestExport(f.papa)).status).toBe(202);
  });
});

describe("UC-09 — préparation, courriel et téléchargement", () => {
  it("préparation : lien par courriel au demandeur, l'autre parent prévenu, journal", async () => {
    const { id } = await readyExport();
    const mail = vi.mocked(sendFamilyExportEmail).mock.lastCall[0];
    expect(mail.to).toBe(f.papa.email);
    expect(mail.familyName).toBe("Fall");
    expect(mail.token).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await db.select().from(familyExports).where(eq(familyExports.id, id));
    expect(row.tokenHash).not.toBe(mail.token);
    expect(row.expiresAt.getTime() - row.readyAt.getTime()).toBe(HOUR);
    expect(fs.existsSync(path.join(EXPORT_DIR, row.filePath))).toBe(true);

    const notes = await db.select().from(notifications).where(eq(notifications.category, "family_export"));
    expect(notes.map((n) => n.userId)).toEqual([f.maman.id]);
    expect(notes[0].title).toBe("Mouhamed Fall a exporté les données de la famille");
    expect(notes[0].body).toContain(`le ${dateTimeLabel(row.readyAt)}`);
    expect(notes[0].emailStatus).toBe("pending");

    const sent = await db.select().from(activityLog).where(eq(activityLog.action, "family_export_sent"));
    expect(sent).toHaveLength(1);
  });

  it("le téléchargement exige d'être connecté avec le compte du demandeur ; usage unique ; fichier effacé", async () => {
    const { id, token } = await readyExport();
    expect((await download(f.maman, token)).status).toBe(403);
    expect((await download(f.intrus, token)).status).toBe(403);
    expect((await as(f.papa).get(`/api/exports/${"0".repeat(64)}/download`)).status).toBe(404);
    const info = await as(f.papa).get(`/api/exports/${token}`);
    expect(info.body).toMatchObject({ status: "ready", familyName: "Fall" });

    const res = await download(f.papa, token);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["content-disposition"]).toMatch(/sunusante-famille-fall-\d{4}-\d{2}-\d{2}\.zip/);
    await new Promise((r) => setTimeout(r, 50));
    const [row] = await db.select().from(familyExports).where(eq(familyExports.id, id));
    expect(row.status).toBe("downloaded");
    expect(row.downloadedAt).not.toBeNull();
    expect(fs.readdirSync(EXPORT_DIR)).toHaveLength(0);
    expect((await download(f.papa, token)).status).toBe(410);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "family_export_downloaded"))).toHaveLength(1);
  });

  it("expiration au bout d'une heure : lien refusé, fichier effacé par le worker", async () => {
    const { id, token } = await readyExport();
    const later = new Date(Date.now() + HOUR + 60 * 1000);
    await exportsTick(later);
    const [row] = await db.select().from(familyExports).where(eq(familyExports.id, id));
    expect(row.status).toBe("expired");
    expect(fs.readdirSync(EXPORT_DIR)).toHaveLength(0);
    expect((await download(f.papa, token)).status).toBe(410);
  });

  it("le worker prépare une demande que le serveur n'a pas traitée", async () => {
    const res = await requestExport(f.papa);
    await exportsTick(new Date());
    const [row] = await db.select().from(familyExports).where(eq(familyExports.id, res.body.export.id));
    expect(row.status).toBe("ready");
    expect(sendFamilyExportEmail).toHaveBeenCalledTimes(1);
    // Une seconde préparation de la même demande est sans effet.
    expect(await prepareFamilyExport(row.id)).toBeNull();
  });

  it("une nouvelle demande annule le lien précédent", async () => {
    const first = await readyExport();
    await requestExport(f.papa);
    const [row] = await db.select().from(familyExports).where(eq(familyExports.id, first.id));
    expect(row.status).toBe("expired");
    expect((await download(f.papa, first.token)).status).toBe(410);
  });
});

describe("UC-09 — contenu de l'archive", () => {
  async function archiveOf(user) {
    const { token } = await readyExport(user);
    const res = await download(user, token);
    expect(res.status).toBe(200);
    return zipEntries(res.body);
  }

  it("A1 : ses dossiers lisibles, jamais celui de l'autre parent ni une fiche archivée", async () => {
    await db.update(members).set({ archivedAt: new Date(), archivedReason: "departure" }).where(eq(members.id, f.fToutou.id));
    const entries = await archiveOf(f.papa);
    const names = [...entries.keys()];
    expect(names).toEqual(
      expect.arrayContaining([
        "LISEZMOI.txt",
        "donnees-famille.json",
        "journal-activite.pdf",
        "dossiers/Mouhamed-Fall.pdf",
        "dossiers/Moussa-Fall.pdf",
        "dossiers/Fatou-Fall.pdf",
      ])
    );
    expect(names.some((n) => n.includes("Awa"))).toBe(false);
    expect(names.some((n) => n.includes("Toutou"))).toBe(false);
    // Fichiers des documents, rangés par fiche (A1 voit le document confidentiel).
    const today = (d) => dayLabel(d).split("/").reverse().join("-");
    expect(names).toContain(`documents/Fatou-Fall/${today(f.docOk.uploadedAt)}-ordonnance-amlodipine.pdf`);
    expect(names).toContain(`documents/Fatou-Fall/${today(f.docSecret.uploadedAt)}-resultat-confidentiel.pdf`);
    expect(entries.get(`documents/Fatou-Fall/${today(f.docOk.uploadedAt)}-ordonnance-amlodipine.pdf`)().toString()).toContain("contenu de test");

    const json = entries.get("donnees-famille.json")().toString("utf8");
    const data = JSON.parse(json);
    expect(data.famille.nom).toBe("Fall");
    expect(data.fiches.map((x) => x.identite.prenom).sort()).toEqual(["Fatou", "Mouhamed", "Moussa"]);
    expect(json).not.toContain("Allergie secrète d'Awa");
    expect(json).not.toContain("Document privé d'Awa");
    expect(json).not.toMatch(/password|passwordHash|tokenHash|token_hash/i);
    expect(data.comptes.map((c) => c.email)).toContain(f.maman.email);
    const fatou = data.fiches.find((x) => x.identite.prenom === "Fatou");
    expect(fatou.traitements.find((t) => t.enCours).medicaments[0].prises12DerniersMois).toHaveLength(4);
    expect(fatou.rolesSurLeDossier.map((r) => r.role).sort()).toEqual(["Gestionnaire", "Lecteur invité", "Relais"]);
    expect(data.journal.length).toBeGreaterThan(0);

    expect(entries.get("LISEZMOI.txt")().toString("utf8")).toContain("DONNÉES DE SANTÉ CONFIDENTIELLES");
    expect(pdfText(entries.get("dossiers/Fatou-Fall.pdf")())).toContain("Dossier médical de Fatou Fall");
    expect(pdfText(entries.get("journal-activite.pdf")())).toContain("Journal d'activité — Fall");
  });

  it("A2 : sans la fiche de A1 ni le document confidentiel d'autrui", async () => {
    const entries = await archiveOf(f.maman);
    const names = [...entries.keys()];
    expect(names).toContain("dossiers/Awa-Fall.pdf");
    expect(names).toContain("dossiers/Fatou-Fall.pdf");
    expect(names.some((n) => n.includes("Mouhamed"))).toBe(false);
    expect(names.some((n) => n.includes("resultat-confidentiel"))).toBe(false);
    const json = entries.get("donnees-famille.json")().toString("utf8");
    expect(json).not.toContain("Résultat confidentiel");
    expect(pdfText(entries.get("dossiers/Fatou-Fall.pdf")())).not.toContain("Résultat confidentiel");
  });

  it("avec délégation, le dossier de l'autre parent est inclus", async () => {
    await grantRole(f.fMaman, f.papa, "lecteur_invite");
    await db
      .update(documentRoles)
      .set({ expiresAt: new Date(Date.now() + 24 * HOUR) })
      .where(and(eq(documentRoles.userId, f.papa.id), eq(documentRoles.memberId, f.fMaman.id)));
    const names = [...(await archiveOf(f.papa)).keys()];
    expect(names).toContain("dossiers/Awa-Fall.pdf");
  });
});
