import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { documents, members } from "../src/db/schema.js";
import { UPLOAD_DIR_PATH } from "../src/middleware/upload.js";
import { resetDatabase, createFamily, createUser, addMembership, createMember, as } from "./helpers.js";

// Téléversement et service des fichiers : contenu vérifié, type imposé par le
// serveur, aucun fichier laissé sur le disque après un refus ou une suppression.
const PDF = Buffer.from("%PDF-1.4\n%fake\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const HTML = Buffer.from("<html><script>alert(document.cookie)</script></html>");

let parent, fiche, other;
const files = () => new Set(fs.readdirSync(UPLOAD_DIR_PATH));
const newFiles = (before) => [...files()].filter((f) => !before.has(f));

beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Fall");
  parent = await createUser("Parent");
  await addMembership(parent, family, "parent", { isPrimaryAdmin: true });
  fiche = await createMember(family, "Fiche");
  other = await createUser("Autre"); // compte sans famille
});

const upload = (user, memberId, buffer, filename, contentType) =>
  as(user)
    .post("/api/documents")
    .field("memberId", String(memberId))
    .field("title", "Doc")
    .field("documentType", "autre")
    .attach("file", buffer, { filename, contentType });

describe("Téléversement", () => {
  it("un fichier HTML déguisé en PDF est refusé et effacé", async () => {
    const before = files();
    const res = await upload(parent, fiche.id, HTML, "piege.html", "application/pdf");
    expect(res.status).toBe(400);
    expect(newFiles(before)).toHaveLength(0);
  });

  it("l'extension stockée vient du type, pas du nom envoyé", async () => {
    const res = await upload(parent, fiche.id, PDF, "ordonnance.html", "application/pdf");
    expect(res.status).toBe(201);
    expect(res.body.fileUrl).toMatch(/\.pdf$/);
    fs.unlinkSync(path.join(UPLOAD_DIR_PATH, path.basename(res.body.fileUrl)));
  });

  it("refusé faute d'accès : rien ne reste sur le disque", async () => {
    const before = files();
    expect((await upload(other, fiche.id, PDF, "a.pdf", "application/pdf")).status).toBe(403);
    expect((await upload(parent, 999999, PDF, "a.pdf", "application/pdf")).status).toBeGreaterThanOrEqual(400);
    expect(newFiles(before)).toHaveLength(0);
  });
});

describe("Service des fichiers", () => {
  it("PDF en ligne, image sous CSP « sandbox », nosniff partout", async () => {
    const pdf = await upload(parent, fiche.id, PDF, "a.pdf", "application/pdf");
    const png = await upload(parent, fiche.id, PNG, "a.png", "image/png");
    const r1 = await as(parent).get(pdf.body.fileUrl);
    expect(r1.headers["content-type"]).toContain("application/pdf");
    expect(r1.headers["x-content-type-options"]).toBe("nosniff");
    expect(r1.headers["content-disposition"]).toBeUndefined();
    // Aperçu en cadre dans la page Documents : autorisé sur le site, sans CSP bloquante.
    expect(r1.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(r1.headers["content-security-policy"]).toBeUndefined();
    const r2 = await as(parent).get(png.body.fileUrl);
    expect(r2.headers["content-type"]).toContain("image/png");
    expect(r2.headers["content-security-policy"]).toContain("sandbox");
    for (const r of [pdf, png]) fs.unlinkSync(path.join(UPLOAD_DIR_PATH, path.basename(r.body.fileUrl)));
  });

  it("un ancien fichier à l'extension inattendue part en téléchargement brut", async () => {
    const name = `ancien-${Date.now()}.html`;
    fs.writeFileSync(path.join(UPLOAD_DIR_PATH, name), HTML);
    await db.insert(documents).values({ memberId: fiche.id, title: "Ancien", documentType: "autre", fileUrl: `/uploads/${name}`, originalName: "x.html" });
    const res = await as(parent).get(`/uploads/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
    expect(res.headers["content-disposition"]).toContain("attachment");
    fs.unlinkSync(path.join(UPLOAD_DIR_PATH, name));
  });

  it("supprimer une fiche efface ses fichiers du disque", async () => {
    const res = await upload(parent, fiche.id, PDF, "a.pdf", "application/pdf");
    const file = path.join(UPLOAD_DIR_PATH, path.basename(res.body.fileUrl));
    expect(fs.existsSync(file)).toBe(true);
    expect((await as(parent).delete(`/api/members?id=${fiche.id}`)).status).toBe(200);
    expect(await db.select().from(members).where(eq(members.id, fiche.id))).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
  });
});
