import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import { documents, familyExports, members } from "../src/db/schema.js";
import { UPLOAD_DIR_PATH } from "../src/middleware/upload.js";
import { sendDoctorShareEmail } from "../src/lib/mailer.js";
import { encryptLegacyDocuments } from "../src/lib/documentFiles.js";
import { EXPORT_DIR, prepareFamilyExport } from "../src/lib/familyExport.js";
import { HEADER_LENGTH, MAGIC, parseMasterKey, plainContent, resolveDocumentKeys } from "../src/lib/fileEncryption.js";
import { resetDatabase, createFamily, createUser, addMembership, createMember, linkMember, as } from "./helpers.js";

// Chiffrement des documents au repos (UC-57, S2, UC-58) : fichiers chiffrés
// sur le disque, restitués à l'identique, altération détectée, conversion
// des anciens fichiers en clair, archives d'export, clé maîtresse.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendDoctorShareEmail: vi.fn(async () => {}),
}));

// Contenu reconnaissable : il ne doit jamais apparaître tel quel sur le disque.
const SECRET = "Ordonnance confidentielle : amoxicilline 1 g matin et soir";
const pdf = (extra = "") => Buffer.from(`%PDF-1.4\n${SECRET}${extra}\n${"x".repeat(200_000)}\n%%EOF\n`);

const binary = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

const KEY_B64 = crypto.randomBytes(32).toString("base64");
const KEY_HEX = crypto.randomBytes(32).toString("hex");

let papa, fiche;
const createdFiles = [];
const diskPath = (fileUrl) => path.join(UPLOAD_DIR_PATH, path.basename(fileUrl));
const savedEnv = {};

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(sendDoctorShareEmail).mockClear();
  const family = await createFamily("Fall");
  papa = await createUser("Mouhamed");
  const medoune = await createUser("Medoune");
  await addMembership(papa, family, "parent", { isPrimaryAdmin: true });
  const m = await addMembership(medoune, family, "adult");
  fiche = await createMember(family, "Medoune");
  await db.update(members).set({ dateOfBirth: "2000-01-01" }).where(eq(members.id, fiche.id));
  await linkMember(m, fiche);
  for (const name of ["DOCUMENTS_ENCRYPTION_KEY", "DOCUMENTS_ENCRYPTION_KEY_PREVIOUS"]) savedEnv[name] = process.env[name];
});

afterEach(() => {
  for (const p of createdFiles.splice(0)) fs.rmSync(p, { force: true });
  fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

async function upload(buffer, filename = "ordonnance.pdf", contentType = "application/pdf") {
  const res = await as(papa)
    .post("/api/documents")
    .field("memberId", String(fiche.id))
    .field("title", "Ordonnance")
    .field("documentType", "ordonnance")
    .attach("file", buffer, { filename, contentType });
  expect(res.status).toBe(201);
  createdFiles.push(diskPath(res.body.fileUrl));
  return res.body;
}

const fetchFile = (fileUrl) => as(papa).get(fileUrl).buffer(true).parse(binary);

// Ancien document, téléversé avant le chiffrement : fichier en clair sur le disque.
async function legacyDocument(content) {
  const name = `${crypto.randomUUID()}.pdf`;
  fs.writeFileSync(path.join(UPLOAD_DIR_PATH, name), content);
  createdFiles.push(path.join(UPLOAD_DIR_PATH, name));
  const [doc] = await db
    .insert(documents)
    .values({ memberId: fiche.id, title: "Ancien", documentType: "autre", fileUrl: `/uploads/${name}`, originalName: "ancien.pdf" })
    .returning();
  return doc;
}

describe("Documents chiffrés sur le disque", () => {
  it("le fichier téléversé est chiffré (magic, aucun contenu en clair) et restitué à l'identique", async () => {
    const content = pdf();
    const doc = await upload(content);
    const stored = fs.readFileSync(diskPath(doc.fileUrl));
    expect(stored.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(stored.includes(Buffer.from(SECRET))).toBe(false);
    expect(stored.includes(Buffer.from("%PDF"))).toBe(false);
    expect(stored.length).toBe(content.length + HEADER_LENGTH);

    const res = await fetchFile(doc.fileUrl);
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, content)).toBe(0);
    expect(res.headers["content-length"]).toBe(String(content.length));
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("un document Word part en téléchargement, sous son nom d'origine, déchiffré", async () => {
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(SECRET)]);
    const doc = await upload(docx, "compte-rendu.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const res = await fetchFile(doc.fileUrl);
    expect(Buffer.compare(res.body, docx)).toBe(0);
    expect(res.headers["content-disposition"]).toContain("compte-rendu.docx");
  });

  it("restitué à l'identique par le lien médecin", async () => {
    const content = pdf();
    const doc = await upload(content);
    const created = await as(papa).post("/api/doctor-shares").send({ memberId: fiche.id, doctorEmail: "dr.ndiaye@clinique.sn", documentIds: [doc.id] });
    expect(created.status).toBe(201);
    const token = vi.mocked(sendDoctorShareEmail).mock.lastCall[0].link.split("/medecin/")[1];
    const medecin = request.agent(app);
    expect((await medecin.post(`/api/public/doctor/${token}/open`)).status).toBe(200);
    const res = await medecin.get(`/api/public/doctor/${token}/documents/${doc.id}`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, content)).toBe(0);
  });

  it("deux fichiers identiques donnent deux fichiers chiffrés différents (clé et IV propres)", async () => {
    const content = pdf();
    const a = fs.readFileSync(diskPath((await upload(content)).fileUrl));
    const b = fs.readFileSync(diskPath((await upload(content)).fileUrl));
    expect(a.length).toBe(b.length);
    expect(a.equals(b)).toBe(false);
    // Clé de données enveloppée et IV du contenu différents ; contenu chiffré aussi.
    expect(a.subarray(25, 57).equals(b.subarray(25, 57))).toBe(false);
    expect(a.subarray(73, 85).equals(b.subarray(73, 85))).toBe(false);
    expect(a.subarray(HEADER_LENGTH).equals(b.subarray(HEADER_LENGTH))).toBe(false);
  });

  it("un fichier altéré (un octet modifié) n'est jamais servi ; l'erreur est journalisée", async () => {
    const content = pdf();
    const doc = await upload(content);
    const file = diskPath(doc.fileUrl);
    const stored = fs.readFileSync(file);
    stored[HEADER_LENGTH + 1000] ^= 0x01;
    fs.writeFileSync(file, stored);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await fetchFile(doc.fileUrl);
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.includes(Buffer.from(SECRET))).toBe(false);
    expect(JSON.parse(res.body.toString()).error).toContain("illisible");
    expect(logged.mock.calls.flat().join(" ")).toContain("altéré");
  });

  it("une enveloppe altérée (en-tête) est aussi refusée", async () => {
    const doc = await upload(pdf());
    const file = diskPath(doc.fileUrl);
    const stored = fs.readFileSync(file);
    stored[30] ^= 0x01; // clé de données enveloppée
    fs.writeFileSync(file, stored);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await fetchFile(doc.fileUrl)).status).toBe(500);
  });

  it("le contrôle du type se fait sur le contenu en clair : un HTML déguisé est refusé, rien sur le disque", async () => {
    const before = new Set(fs.readdirSync(UPLOAD_DIR_PATH));
    const res = await as(papa)
      .post("/api/documents")
      .field("memberId", String(fiche.id))
      .field("title", "Piège")
      .field("documentType", "autre")
      .attach("file", Buffer.from("<html><script>alert(1)</script></html>"), { filename: "a.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("ne correspond pas à son type");
    expect(fs.readdirSync(UPLOAD_DIR_PATH).filter((f) => !before.has(f))).toHaveLength(0);
  });
});

describe("Anciens fichiers en clair : conversion au démarrage", () => {
  it("lisible avant la conversion, chiffré par la migration, restitué à l'identique ; relancer ne le touche plus", async () => {
    const content = pdf(" (ancien)");
    const doc = await legacyDocument(content);
    const file = diskPath(doc.fileUrl);

    // Avant conversion : servi tel quel.
    const before = await fetchFile(doc.fileUrl);
    expect(before.status).toBe(200);
    expect(Buffer.compare(before.body, content)).toBe(0);

    const report = await encryptLegacyDocuments();
    expect(report).toMatchObject({ encrypted: 1, alreadyEncrypted: 0, errors: 0 });
    const stored = fs.readFileSync(file);
    expect(stored.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(stored.includes(Buffer.from(SECRET))).toBe(false);
    // Aucun fichier temporaire laissé.
    expect(fs.readdirSync(UPLOAD_DIR_PATH).some((n) => n.endsWith(".chiffrement.tmp"))).toBe(false);

    const after = await fetchFile(doc.fileUrl);
    expect(Buffer.compare(after.body, content)).toBe(0);

    // Idempotent : rien n'est rechiffré.
    const again = await encryptLegacyDocuments();
    expect(again).toMatchObject({ encrypted: 0, alreadyEncrypted: 1, errors: 0 });
    expect(fs.readFileSync(file).equals(stored)).toBe(true);
  });

  it("document sans fichier sur le disque : signalé introuvable, sans erreur ; restes temporaires effacés", async () => {
    await db.insert(documents).values({ memberId: fiche.id, title: "Absent", documentType: "autre", fileUrl: "/uploads/absent-chiffrement.pdf" });
    const leftover = path.join(UPLOAD_DIR_PATH, `x.pdf.${crypto.randomUUID()}.chiffrement.tmp`);
    fs.writeFileSync(leftover, "reste");
    createdFiles.push(leftover);
    expect(await encryptLegacyDocuments()).toMatchObject({ encrypted: 0, missing: 1, errors: 0 });
    expect(fs.existsSync(leftover)).toBe(false);
  });
});

// ── Archive d'export (UC-09) ─────────────────────────────────────────────────

function zipEntries(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  expect(eocd).toBeGreaterThanOrEqual(0);
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
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("Archive d'export chiffrée", () => {
  it("écrite chiffrée sur le disque, téléchargée à l'identique (ZIP valide, documents en clair dedans)", async () => {
    const content = pdf(" (export)");
    await upload(content);
    const [row] = await db.insert(familyExports).values({ familyId: fiche.familyId, requestedByUserId: papa.id }).returning();
    let token;
    const ready = await prepareFamilyExport(row.id, { sendMail: async (mail) => (token = mail.token) });
    expect(ready.status).toBe("ready");

    const archivePath = path.join(EXPORT_DIR, ready.filePath);
    const stored = fs.readFileSync(archivePath);
    expect(stored.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(stored.subarray(0, 2).toString()).not.toBe("PK");
    expect(stored.length).toBe(ready.sizeBytes + HEADER_LENGTH);
    const chunks = [];
    for await (const chunk of plainContent(archivePath)) chunks.push(chunk);
    const plain = Buffer.concat(chunks);

    const res = await as(papa).get(`/api/exports/${token}/download`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["content-length"]).toBe(String(ready.sizeBytes));
    expect(Buffer.compare(res.body, plain)).toBe(0);
    expect(res.body.subarray(0, 2).toString()).toBe("PK");

    const entries = zipEntries(res.body);
    const docEntry = [...entries.keys()].find((n) => n.startsWith("documents/") && n.endsWith(".pdf"));
    expect(docEntry).toBeTruthy();
    expect(Buffer.compare(entries.get(docEntry), content)).toBe(0);
    expect(JSON.parse(entries.get("donnees-famille.json").toString()).fiches.length).toBeGreaterThan(0);

    // Supprimée après le téléchargement, comme avant.
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(archivePath)).toBe(false);
  });

  it("un document altéré est signalé manquant dans l'archive, jamais copié abîmé", async () => {
    const doc = await upload(pdf());
    const file = diskPath(doc.fileUrl);
    const stored = fs.readFileSync(file);
    stored[stored.length - 1] ^= 0x01;
    fs.writeFileSync(file, stored);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const [row] = await db.insert(familyExports).values({ familyId: fiche.familyId, requestedByUserId: papa.id }).returning();
    let token;
    const ready = await prepareFamilyExport(row.id, { sendMail: async (mail) => (token = mail.token) });
    expect(ready.status).toBe("ready");
    expect(logged.mock.calls.flat().join(" ")).toContain("altéré");
    const res = await as(papa).get(`/api/exports/${token}/download`).buffer(true).parse(binary);
    const entries = zipEntries(res.body);
    expect([...entries.keys()].some((n) => n.startsWith("documents/"))).toBe(false);
    const json = JSON.parse(entries.get("donnees-famille.json").toString());
    expect(json.fiches.flatMap((f) => f.documents ?? []).some((d) => d.fichierManquant)).toBe(true);
  });
});

// ── Clé maîtresse ────────────────────────────────────────────────────────────

describe("Clé maîtresse DOCUMENTS_ENCRYPTION_KEY", () => {
  const JWT = "secret_jwt_de_test";

  it("production sans clé : refus de démarrer", () => {
    expect(() => resolveDocumentKeys({ NODE_ENV: "production", JWT_ACCESS_SECRET: JWT })).toThrow(/requise en production/);
    expect(() => resolveDocumentKeys({ NODE_ENV: "production", DOCUMENTS_ENCRYPTION_KEY: "  ", JWT_ACCESS_SECRET: JWT })).toThrow(
      /requise en production/
    );
  });

  it("au démarrage réel du module (serveur et worker) : refus en production sans clé ou avec une clé invalide", () => {
    const start = (env) =>
      spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./src/lib/fileEncryption.js')"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, JWT_ACCESS_SECRET: JWT, ...env },
        encoding: "utf8",
      });
    const missing = start({ NODE_ENV: "production" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("DOCUMENTS_ENCRYPTION_KEY est requise en production");
    const invalid = start({ NODE_ENV: "production", DOCUMENTS_ENCRYPTION_KEY: "pas-une-cle" });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("DOCUMENTS_ENCRYPTION_KEY invalide");
    expect(start({ NODE_ENV: "production", DOCUMENTS_ENCRYPTION_KEY: KEY_B64 }).status).toBe(0);
    expect(start({ NODE_ENV: "production", DOCUMENTS_ENCRYPTION_KEY: KEY_HEX }).status).toBe(0);
    // Développement sans clé : démarrage avec un avertissement (clé dérivée).
    const dev = start({ NODE_ENV: "development" });
    expect(dev.status).toBe(0);
    expect(dev.stderr).toContain("DOCUMENTS_ENCRYPTION_KEY absente");
  });

  it("clé invalide : erreur, en production comme en développement", () => {
    for (const NODE_ENV of ["production", "development"]) {
      for (const bad of ["trop-courte", crypto.randomBytes(16).toString("base64"), "z".repeat(64), crypto.randomBytes(31).toString("hex")]) {
        expect(() => resolveDocumentKeys({ NODE_ENV, DOCUMENTS_ENCRYPTION_KEY: bad, JWT_ACCESS_SECRET: JWT })).toThrow(/invalide/);
      }
    }
    expect(() =>
      resolveDocumentKeys({ NODE_ENV: "production", DOCUMENTS_ENCRYPTION_KEY: KEY_B64, DOCUMENTS_ENCRYPTION_KEY_PREVIOUS: "abc" })
    ).toThrow(/DOCUMENTS_ENCRYPTION_KEY_PREVIOUS invalide/);
  });

  it("clé fournie en base64 ou en hexadécimal : acceptée (même clé)", () => {
    const raw = crypto.randomBytes(32);
    expect(parseMasterKey(raw.toString("base64")).equals(raw)).toBe(true);
    expect(parseMasterKey(raw.toString("hex")).equals(raw)).toBe(true);
    expect(parseMasterKey(raw.toString("hex").toUpperCase()).equals(raw)).toBe(true);
    const fromB64 = resolveDocumentKeys({ NODE_ENV: "production", DOCUMENTS_ENCRYPTION_KEY: raw.toString("base64") });
    const fromHex = resolveDocumentKeys({ NODE_ENV: "production", DOCUMENTS_ENCRYPTION_KEY: raw.toString("hex") });
    expect(fromB64.derived).toBe(false);
    expect(fromB64.current.key.equals(raw)).toBe(true);
    expect(fromHex.current.id.equals(fromB64.current.id)).toBe(true);
    // En production, jamais de clé dérivée de JWT_ACCESS_SECRET.
    expect(resolveDocumentKeys({ NODE_ENV: "production", DOCUMENTS_ENCRYPTION_KEY: KEY_HEX, JWT_ACCESS_SECRET: JWT }).all).toHaveLength(1);
  });

  it("développement sans clé : clé dérivée de JWT_ACCESS_SECRET", () => {
    const keys = resolveDocumentKeys({ NODE_ENV: "development", JWT_ACCESS_SECRET: JWT });
    expect(keys.derived).toBe(true);
    expect(keys.current.key).toHaveLength(32);
    expect(resolveDocumentKeys({ JWT_ACCESS_SECRET: JWT }).current.key.equals(keys.current.key)).toBe(true);
    expect(resolveDocumentKeys({ JWT_ACCESS_SECRET: "autre" }).current.key.equals(keys.current.key)).toBe(false);
  });

  it("clé fournie : documents chiffrés avec elle ; illisibles sans elle", async () => {
    process.env.DOCUMENTS_ENCRYPTION_KEY = KEY_B64;
    const content = pdf();
    const doc = await upload(content);
    const stored = fs.readFileSync(diskPath(doc.fileUrl));
    const expectedId = resolveDocumentKeys({ DOCUMENTS_ENCRYPTION_KEY: KEY_B64 }).current.id;
    expect(stored.subarray(5, 13).equals(expectedId)).toBe(true);
    expect(Buffer.compare((await fetchFile(doc.fileUrl)).body, content)).toBe(0);

    // Autre clé, sans l'ancienne : fichier illisible (jamais de contenu servi).
    process.env.DOCUMENTS_ENCRYPTION_KEY = KEY_HEX;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await fetchFile(doc.fileUrl)).status).toBe(500);
    expect(logged.mock.calls.flat().join(" ")).toContain("clé maîtresse inconnue");
  });

  it("rotation : l'ancienne clé en DOCUMENTS_ENCRYPTION_KEY_PREVIOUS relit les anciens fichiers ; les nouveaux prennent la nouvelle", async () => {
    process.env.DOCUMENTS_ENCRYPTION_KEY = KEY_B64;
    const content = pdf();
    const ancien = await upload(content);

    process.env.DOCUMENTS_ENCRYPTION_KEY = KEY_HEX;
    process.env.DOCUMENTS_ENCRYPTION_KEY_PREVIOUS = KEY_B64;
    expect(Buffer.compare((await fetchFile(ancien.fileUrl)).body, content)).toBe(0);
    const nouveau = await upload(content);
    const newId = resolveDocumentKeys({ DOCUMENTS_ENCRYPTION_KEY: KEY_HEX }).current.id;
    expect(fs.readFileSync(diskPath(nouveau.fileUrl)).subarray(5, 13).equals(newId)).toBe(true);
    expect(Buffer.compare((await fetchFile(nouveau.fileUrl)).body, content)).toBe(0);
  });
});
