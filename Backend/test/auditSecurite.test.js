import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import { documents, emailVerificationTokens, emergencyCardViews, emergencyCards, members, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { MAX_FAILURES, MAX_FAILURES_PER_IP } from "../src/lib/loginThrottle.js";
import { weakSecretProblems } from "../src/lib/jwt.js";
import { convertLegacyEmergencyTokens } from "../src/lib/sharing.js";
import { UPLOAD_DIR_PATH } from "../src/middleware/upload.js";
import { AUTH_IP_LIMIT } from "../src/routes/auth.js";
import { PUBLIC_IP_LIMIT } from "../src/routes/public.js";
import { FAMILY_STORAGE_QUOTA_BYTES } from "../src/routes/documents.js";
import {
  DEFAULT_NOTIFICATION_SUBJECT,
  buildNotificationEmail,
  sendAccountExistsEmail,
  sendDoctorShareEmail,
  sendEmailChangeEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../src/lib/mailer.js";
import { resetDatabase, createFamily, createUser, addMembership, createMember, linkMember, as } from "./helpers.js";

// Correctifs de l'audit de sécurité : pré-détournement de compte, limites par
// adresse IP, énumération des comptes, limite des tentatives de mot de passe,
// jetons de fiche d'urgence chiffrés, lien médecin et documents confidentiels,
// courriels sans donnée de santé, téléversements bornés.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendAccountExistsEmail: vi.fn(async () => {}),
  sendVerificationEmail: vi.fn(async () => {}),
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendPasswordChangedAlert: vi.fn(async () => {}),
  sendEmailChangeEmail: vi.fn(async () => {}),
  sendEmailChangeNotice: vi.fn(async () => {}),
  sendDoctorShareEmail: vi.fn(async () => {}),
}));

const PASSWORD = "Mon-mdp-123";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Tests qui enchaînent beaucoup de requêtes ou de calculs bcrypt.
const LONG = 30000;

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
});

async function userWithPassword(email, name = "Awa") {
  const [u] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(PASSWORD), name, emailVerified: true })
    .returning();
  return u;
}

const post = (url, body, ip) => {
  const r = request(app).post(url);
  if (ip) r.set("X-Forwarded-For", ip);
  return r.send(body);
};
const login = (email, password, ip) => post("/api/auth/login", { email, password }, ip);
const register = (body, ip) => post("/api/auth/register", body, ip);
const lastVerificationToken = () => vi.mocked(sendVerificationEmail).mock.lastCall[0].token;

describe("Inscription : pré-détournement de compte", () => {
  it("une nouvelle inscription sur une adresse non vérifiée remplace le mot de passe et annule liens et sessions", async () => {
    // Le pirate inscrit l'adresse d'Awa avec SON mot de passe, et se connecte
    // (permis tant que l'adresse n'est pas vérifiée).
    expect((await register({ name: "Pirate", email: "awa@test.local", password: "Pirate-123" })).status).toBe(201);
    const pirateLink = lastVerificationToken();
    const pirate = request.agent(app);
    expect((await pirate.post("/api/auth/login").send({ email: "awa@test.local", password: "Pirate-123" })).status).toBe(200);

    // Awa s'inscrit à son tour (après le délai minimal entre deux envois).
    await db.update(emailVerificationTokens).set({ createdAt: new Date(Date.now() - 2 * 60 * 1000) });
    await wait(1100); // les jetons émis dans la même seconde que le changement resteraient valides
    const res = await register({ name: "Awa Diop", email: "awa@test.local", password: "Vraie-awa-123" });
    expect(res.status).toBe(201);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(2);
    const awaLink = lastVerificationToken();

    // Le lien reçu pour l'inscription du pirate ne fonctionne plus, sa session est fermée.
    expect((await request(app).post(`/api/auth/verify-email/${pirateLink}`)).status).toBe(404);
    expect((await pirate.post("/api/auth/refresh")).status).toBe(401);
    expect((await pirate.get("/api/auth/me")).status).toBe(401);

    // Le lien d'Awa active le compte avec SON mot de passe et son nom.
    const verified = await request(app).post(`/api/auth/verify-email/${awaLink}`);
    expect(verified.status).toBe(200);
    expect(verified.body.name).toBe("Awa Diop");
    expect((await login("awa@test.local", "Pirate-123")).status).toBe(401);
    expect((await login("awa@test.local", "Vraie-awa-123")).status).toBe(200);
  }, LONG);

  it("une minute minimum entre deux envois à la même adresse, même réponse dans tous les cas", async () => {
    const first = await register({ name: "Awa", email: "awa@test.local", password: "Premier-123" });
    const again = await register({ name: "Autre", email: "awa@test.local", password: "Second-123" });
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    // Demande ignorée : le mot de passe n'a pas changé.
    expect((await login("awa@test.local", "Second-123")).status).toBe(401);
    expect((await login("awa@test.local", "Premier-123")).status).toBe(200);

    // Adresse vérifiée : un seul avis « compte existant » par minute.
    await userWithPassword("deja@test.local");
    await register({ name: "X", email: "deja@test.local", password: "Autre-12345" });
    await register({ name: "X", email: "deja@test.local", password: "Autre-12345" });
    expect(sendAccountExistsEmail).toHaveBeenCalledTimes(1);
  });

  it("adresse invalide ou trop longue, nom trop long : refusés", async () => {
    expect((await register({ name: "A", email: "pas-une-adresse", password: "Mdp-12345" })).status).toBe(400);
    expect((await register({ name: "A", email: `${"a".repeat(250)}@test.local`, password: "Mdp-12345" })).status).toBe(400);
    expect((await register({ name: "A".repeat(151), email: "a@test.local", password: "Mdp-12345" })).status).toBe(400);
    expect((await register({ name: "A", email: { $ne: "" }, password: "Mdp-12345" })).status).toBe(400);
  });
});

describe("Énumération des comptes", () => {
  it("renvoi de vérification trop rapproché : même réponse qu'une adresse inconnue, rien n'est envoyé", async () => {
    await register({ name: "Awa", email: "awa@test.local", password: "Premier-123" });
    const resend = await post("/api/auth/resend-verification", { email: "awa@test.local" });
    const unknown = await post("/api/auth/resend-verification", { email: "inconnu@test.local" });
    expect(resend.status).toBe(200);
    expect(resend.body).toEqual(unknown.body);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
  });
});

describe("Limites par adresse IP", () => {
  it(`routes d'authentification : au-delà de ${AUTH_IP_LIMIT} requêtes, 429 pour cette IP seulement`, async () => {
    for (let i = 0; i < AUTH_IP_LIMIT; i++) {
      expect((await post("/api/auth/forgot-password", { email: "x" }, "203.0.113.7")).status).toBe(400);
    }
    const blocked = await post("/api/auth/forgot-password", { email: "x" }, "203.0.113.7");
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect((await post("/api/auth/login", { email: "a@test.local", password: "x" }, "203.0.113.7")).status).toBe(429);
    expect((await post("/api/auth/forgot-password", { email: "x" }, "203.0.113.8")).status).toBe(400);
  }, LONG);

  it(`routes publiques : au-delà de ${PUBLIC_IP_LIMIT} requêtes, 429`, async () => {
    const get = (ip) => request(app).get("/api/public/emergency/inconnu").set("X-Forwarded-For", ip);
    for (let i = 0; i < PUBLIC_IP_LIMIT; i++) expect((await get("198.51.100.1")).status).toBe(404);
    expect((await get("198.51.100.1")).status).toBe(429);
    expect((await get("198.51.100.2")).status).toBe(404);
  }, LONG);
});

describe("Limite des tentatives de mot de passe", () => {
  it("le blocage d'une adresse vise la connexion qui échoue, pas le titulaire sur une autre connexion", async () => {
    await userWithPassword("awa@test.local");
    for (let i = 0; i < MAX_FAILURES; i++) expect((await login("awa@test.local", "mauvais", "192.0.2.10")).status).toBe(401);
    expect((await login("awa@test.local", PASSWORD, "192.0.2.10")).status).toBe(429);
    expect((await login("awa@test.local", PASSWORD, "192.0.2.20")).status).toBe(200);
  });

  it(`essais sur beaucoup de comptes depuis une IP (password spraying) : bloquée après ${MAX_FAILURES_PER_IP} échecs`, async () => {
    await userWithPassword("awa@test.local");
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      expect((await login(`victime${i}@test.local`, "Ete2026!", "192.0.2.30")).status).toBe(401);
    }
    expect((await login("awa@test.local", PASSWORD, "192.0.2.30")).status).toBe(429);
    expect((await login("awa@test.local", PASSWORD, "192.0.2.31")).status).toBe(200);
  }, LONG);

  it("adresse invalide refusée avant tout traitement", async () => {
    expect((await login("pas-une-adresse", "x")).status).toBe(400);
    expect((await login(`${"a".repeat(300)}@test.local`, "x")).status).toBe(400);
    expect((await post("/api/auth/login", { email: ["a@test.local"], password: "x" })).status).toBe(400);
  });

  it("« Mon compte » : le mot de passe actuel est soumis à la même limite", async () => {
    await userWithPassword("awa@test.local");
    const agent = request.agent(app);
    expect((await agent.post("/api/auth/login").send({ email: "awa@test.local", password: PASSWORD })).status).toBe(200);
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await agent.post("/api/account/email").send({ password: "faux", newEmail: "n@test.local" })).status).toBe(403);
    }
    const blocked = await agent.post("/api/account/email").send({ password: PASSWORD, newEmail: "n@test.local" });
    expect(blocked.status).toBe(429);
    expect(sendEmailChangeEmail).not.toHaveBeenCalled();
  });
});

describe("Changement d'adresse", () => {
  it("la confirmation annule les liens « Mot de passe oublié » en attente", async () => {
    await userWithPassword("awa@test.local");
    await post("/api/auth/forgot-password", { email: "awa@test.local" });
    const resetToken = vi.mocked(sendPasswordResetEmail).mock.lastCall[0].token;

    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "awa@test.local", password: PASSWORD });
    expect((await agent.post("/api/account/email").send({ password: PASSWORD, newEmail: "nouvelle@test.local" })).status).toBe(200);
    const changeToken = vi.mocked(sendEmailChangeEmail).mock.lastCall[0].token;
    expect((await request(app).post(`/api/auth/confirm-email-change/${changeToken}`)).status).toBe(200);

    expect((await post(`/api/auth/reset-password/${resetToken}`, { password: "Nouveau-mdp-456" })).status).toBe(409);
  });
});

describe("En-têtes et secrets", () => {
  it("réponses de l'API jamais mises en cache", async () => {
    expect((await request(app).get("/api/health")).headers["cache-control"]).toBe("no-store");
    expect((await login("inconnu@test.local", "x")).headers["cache-control"]).toBe("no-store");
  });

  it("secrets JWT faibles détectés (refus de démarrer en production)", () => {
    const strongA = "a".repeat(40);
    const strongB = "b".repeat(40);
    expect(weakSecretProblems(strongA, strongB)).toEqual([]);
    expect(weakSecretProblems("court", strongB).join()).toContain("moins de 32 caractères");
    expect(weakSecretProblems(`changeme_${strongA}`, strongB).join()).toContain("changeme");
    expect(weakSecretProblems(strongA, strongA).join()).toContain("identiques");
  });

  it("rebonds de courriel : secret accepté dans l'en-tête X-Webhook-Secret", async () => {
    const previous = process.env.MAIL_WEBHOOK_SECRET;
    process.env.MAIL_WEBHOOK_SECRET = "secret-audit";
    try {
      expect((await request(app).post("/api/webhooks/mail").set("X-Webhook-Secret", "secret-audit").send({})).status).toBe(200);
      expect((await request(app).post("/api/webhooks/mail").set("X-Webhook-Secret", "mauvais").send({})).status).toBe(404);
      expect((await request(app).post("/api/webhooks/mail").send({})).status).toBe(404);
      expect((await request(app).post("/api/webhooks/mail/secret-audit").send({})).status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.MAIL_WEBHOOK_SECRET;
      else process.env.MAIL_WEBHOOK_SECRET = previous;
    }
  });
});

describe("Courriels de notification", () => {
  it("l'objet ne contient aucune donnée de santé ; le détail reste dans le corps", () => {
    const mail = buildNotificationEmail({
      subject: "SunuSanté Famille — Prise : Metformine 500 mg",
      heading: "Prise : Metformine 500 mg",
      lines: ["Metformine 500 mg à 08:00"],
      link: "/traitements",
    });
    expect(mail.subject).toBe(DEFAULT_NOTIFICATION_SUBJECT);
    expect(mail.subject).not.toContain("Metformine");
    expect(mail.html).toContain("Metformine 500 mg");
    expect(buildNotificationEmail({ category: "vaccine_reminder", heading: "BCG" }).subject).not.toContain("BCG");
  });
});

// Famille de test : A1 (parent administrateur) et Medoune, adulte titulaire de sa fiche.
async function familleAvecTitulaire() {
  const family = await createFamily("Fall");
  const papa = await createUser("Mouhamed");
  const medoune = await createUser("Medoune");
  await addMembership(papa, family, "parent", { isPrimaryAdmin: true });
  const m = await addMembership(medoune, family, "adult");
  const fiche = await createMember(family, "Medoune");
  await db.update(members).set({ dateOfBirth: "2000-01-01", bloodType: "O+" }).where(eq(members.id, fiche.id));
  await linkMember(m, fiche);
  return { family, papa, medoune, fiche };
}

describe("Fiche d'urgence : jeton chiffré", () => {
  it("la base ne contient ni le jeton en clair ni de quoi le retrouver sans la clé", async () => {
    const { medoune, fiche } = await familleAvecTitulaire();
    const res = await as(medoune).put(`/api/emergency/${fiche.id}`).send({ active: true, fields: { showBloodType: true } });
    const token = res.body.url.split("/urgence/")[1];
    const [card] = await db.select().from(emergencyCards);
    expect(card.token).toBeNull();
    expect(card.tokenHash).toBe(sha256(token));
    expect(card.tokenEncrypted.startsWith("v1:")).toBe(true);
    expect(card.tokenEncrypted).not.toContain(token);
    expect((await request(app).get(`/api/public/emergency/${token}`)).body.bloodType).toBe("O+");
    // Le titulaire réaffiche toujours le même lien.
    expect((await as(medoune).get(`/api/emergency/${fiche.id}`)).body.url).toBe(res.body.url);
  });

  it("anciens jetons en clair : toujours valables, chiffrés à la première utilisation ou au démarrage", async () => {
    const { medoune, fiche } = await familleAvecTitulaire();
    await as(medoune).put(`/api/emergency/${fiche.id}`).send({ active: true, fields: { showBloodType: true } });
    // État laissé par la migration 0013 : jeton en clair + empreinte calculée en SQL.
    const legacy = (t) => db.update(emergencyCards).set({ token: t, tokenHash: sha256(t), tokenEncrypted: null });

    await legacy("ancien-jeton-imprime");
    expect((await request(app).get("/api/public/emergency/ancien-jeton-imprime")).status).toBe(200);
    let [card] = await db.select().from(emergencyCards);
    expect(card.token).toBeNull();
    expect(card.tokenEncrypted).toBeTruthy();
    expect((await as(medoune).get(`/api/emergency/${fiche.id}`)).body.url).toMatch(/\/urgence\/ancien-jeton-imprime$/);

    await legacy("autre-ancien-jeton");
    expect(await convertLegacyEmergencyTokens()).toBe(1);
    [card] = await db.select().from(emergencyCards);
    expect(card.token).toBeNull();
    expect((await request(app).get("/api/public/emergency/autre-ancien-jeton")).status).toBe(200);
  });

  it("consultations : une ligne par minute au plus pour une même fiche", async () => {
    const { medoune, fiche } = await familleAvecTitulaire();
    const res = await as(medoune).put(`/api/emergency/${fiche.id}`).send({ active: true, fields: { showBloodType: true } });
    const token = res.body.url.split("/urgence/")[1];
    for (let i = 0; i < 3; i++) expect((await request(app).get(`/api/public/emergency/${token}`)).status).toBe(200);
    expect(await db.select().from(emergencyCardViews)).toHaveLength(1);
    await db.update(emergencyCardViews).set({ viewedAt: new Date(Date.now() - 2 * 60 * 1000) });
    await request(app).get(`/api/public/emergency/${token}`);
    expect(await db.select().from(emergencyCardViews)).toHaveLength(2);
  });
});

describe("Lien médecin et documents confidentiels", () => {
  const DOCTOR = "dr.ndiaye@clinique.sn";
  const sentToken = () => vi.mocked(sendDoctorShareEmail).mock.lastCall[0].link.split("/medecin/")[1];
  async function openAsDoctor(token) {
    const medecin = request.agent(app);
    expect((await medecin.post(`/api/public/doctor/${token}/open`)).status).toBe(200);
    return medecin;
  }

  it("document devenu confidentiel après un lien créé par A1 : exclu de la synthèse et du téléchargement", async () => {
    const { papa, fiche } = await familleAvecTitulaire();
    const [doc] = await db
      .insert(documents)
      .values({ memberId: fiche.id, title: "Bilan", documentType: "autre", fileUrl: "/uploads/absent-audit.pdf" })
      .returning();
    const created = await as(papa).post("/api/doctor-shares").send({ memberId: fiche.id, doctorEmail: DOCTOR, documentIds: [doc.id] });
    expect(created.status).toBe(201);
    const token = sentToken();
    // Le titulaire marque ensuite le document confidentiel.
    await db.update(documents).set({ isConfidential: true }).where(eq(documents.id, doc.id));

    const medecin = await openAsDoctor(token);
    const synthesis = await medecin.get(`/api/public/doctor/${token}`);
    expect(synthesis.status).toBe(200);
    expect(synthesis.body.documents).toEqual([]);
    expect((await medecin.get(`/api/public/doctor/${token}/documents/${doc.id}`)).status).toBe(403);
  });

  it("lien créé par le titulaire : son document confidentiel reste visible", async () => {
    const { medoune, fiche } = await familleAvecTitulaire();
    const [doc] = await db
      .insert(documents)
      .values({ memberId: fiche.id, title: "Secret", documentType: "autre", isConfidential: true, fileUrl: "/uploads/absent-audit.pdf" })
      .returning();
    expect((await as(medoune).post("/api/doctor-shares").send({ memberId: fiche.id, doctorEmail: DOCTOR, documentIds: [doc.id] })).status).toBe(201);
    const token = sentToken();
    const medecin = await openAsDoctor(token);
    const synthesis = await medecin.get(`/api/public/doctor/${token}`);
    expect(synthesis.body.documents).toHaveLength(1);
    expect(synthesis.body.documents[0]).not.toHaveProperty("isConfidential");
    // Autorisé : on va jusqu'au fichier (absent ici, d'où 404 et non 403).
    expect((await medecin.get(`/api/public/doctor/${token}/documents/${doc.id}`)).status).toBe(404);
  });
});

describe("Téléversement borné", () => {
  const PDF = Buffer.from("%PDF-1.4\n%fake\n");
  const files = () => new Set(fs.readdirSync(UPLOAD_DIR_PATH));
  const newFiles = (before) => [...files()].filter((f) => !before.has(f));

  it("trop de champs dans le formulaire : refusé", async () => {
    const { papa, fiche } = await familleAvecTitulaire();
    let req = as(papa).post("/api/documents").field("memberId", String(fiche.id));
    for (let i = 0; i < 25; i++) req = req.field(`champ${i}`, "x");
    expect((await req).status).toBe(400);
  });

  it("quota de la famille atteint : refusé avant d'écrire le fichier", async () => {
    const { papa, fiche } = await familleAvecTitulaire();
    await db.insert(documents).values({ memberId: fiche.id, title: "Gros", documentType: "autre", fileUrl: "/uploads/gros-audit.pdf" });
    const stat = vi.spyOn(fs.promises, "stat").mockResolvedValue({ size: FAMILY_STORAGE_QUOTA_BYTES });
    try {
      const before = files();
      const res = await as(papa)
        .post("/api/documents")
        .field("memberId", String(fiche.id))
        .field("title", "Doc")
        .field("documentType", "autre")
        .attach("file", PDF, { filename: "a.pdf", contentType: "application/pdf" });
      expect(res.status).toBe(413);
      expect(res.body.error).toContain("500 Mo");
      expect(newFiles(before)).toHaveLength(0);
    } finally {
      stat.mockRestore();
    }
  });

  it("memberId envoyé après le fichier : mêmes contrôles, rien ne reste sur le disque", async () => {
    const { fiche } = await familleAvecTitulaire();
    const outsider = await createUser("Autre");
    const before = files();
    const res = await as(outsider)
      .post("/api/documents")
      .attach("file", PDF, { filename: "a.pdf", contentType: "application/pdf" })
      .field("memberId", String(fiche.id))
      .field("title", "Doc")
      .field("documentType", "autre");
    expect(res.status).toBe(403);
    expect(newFiles(before)).toHaveLength(0);
  });
});
