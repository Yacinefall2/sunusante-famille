import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import { appointments, members, technicalLogs, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { sendAccountExistsEmail } from "../src/lib/mailer.js";
import { sendToSubscription } from "../src/lib/push.js";
import { httpErrorLogger, logTechnical, maskEmail, purgeTechnicalLogs, routeOf, shortUserAgent, truncateIp } from "../src/lib/technicalLog.js";
import { runWorkerCycle } from "../src/reminders/cycle.js";
import { resetDatabase, createFamily, addMembership, createMember, linkMember, createSupport, asSupport, as } from "./helpers.js";

// Journaux techniques (UC-53) : métadonnées seulement — jamais de donnée
// médicale, jamais de corps de requête ni de réponse, adresse IP tronquée,
// destinataire masqué ; purge après 90 jours.
const webpush = vi.hoisted(() => ({ sendNotification: vi.fn(), setVapidDetails: vi.fn() }));
vi.mock("web-push", () => ({ default: webpush }));

const PASSWORD = "Mon-mdp-secret-123";
let awa;

const allLogs = async () => db.select().from(technicalLogs).orderBy(technicalLogs.id);

beforeEach(async () => {
  await resetDatabase();
  [awa] = await db
    .insert(users)
    .values({ email: "yacine.diop@gmail.com", passwordHash: await hashPassword(PASSWORD), name: "Yacine Diop", emailVerified: true })
    .returning();
});

describe("Outils de journalisation", () => {
  it("IP tronquée (/24 en IPv4, /48 en IPv6), destinataire masqué, navigateur court, route sans valeurs", () => {
    expect(truncateIp("203.0.113.57")).toBe("203.0.113.0/24");
    expect(truncateIp("::ffff:198.51.100.23")).toBe("198.51.100.0/24");
    expect(truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3::/48");
    expect(truncateIp("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(truncateIp("pas une ip")).toBeNull();
    expect(maskEmail("yacine@gmail.com")).toBe("y***@gmail.com");
    expect(shortUserAgent("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")).toBe("Chrome sur Android");
    expect(routeOf({ originalUrl: "/api/members/42/export.pdf?secret=1" })).toBe("/api/members/:id/export.pdf");
    expect(routeOf({ originalUrl: "/api/auth/verify-email/0123456789abcdef0123456789abcdef" })).toBe("/api/auth/verify-email/:valeur");
  });

  it("les clés de métadonnées non prévues (corps, titre…) sont ignorées", async () => {
    await logTechnical({ category: "auth", message: "Essai", metadata: { body: { title: "RDV-Secret" }, title: "RDV-Secret", ip: "203.0.113.9", userId: 4 } });
    const [entry] = await allLogs();
    expect(entry.metadata).toEqual({ ip: "203.0.113.0/24", userId: 4 });
  });
});

describe("Sources du journal", () => {
  it("connexions réussies et échouées : sans mot de passe ni adresse, IP tronquée", async () => {
    const login = (password) =>
      request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "203.0.113.57")
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0) Chrome/126.0")
        .send({ email: "yacine.diop@gmail.com", password });
    await login("mauvais-mot-de-passe");
    await login(PASSWORD);
    const logs = (await allLogs()).filter((l) => l.category === "auth");
    expect(logs.map((l) => [l.level, l.message])).toEqual([
      ["warn", "Connexion refusée : mot de passe incorrect"],
      ["info", "Connexion réussie"],
    ]);
    expect(logs[1].metadata).toMatchObject({ route: "/api/auth/login", method: "POST", ip: "203.0.113.0/24", userId: awa.id, userAgent: "Chrome sur Windows" });
    const dump = JSON.stringify(await allLogs());
    expect(dump).not.toContain("mauvais-mot-de-passe");
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain("yacine.diop@gmail.com");
    expect(dump).not.toContain("203.0.113.57");
  });

  it("limiteur déclenché : noté une fois (catégorie sécurité)", async () => {
    for (let i = 0; i < 7; i++) {
      await request(app).post("/api/auth/login").set("X-Forwarded-For", "198.51.100.4").send({ email: "yacine.diop@gmail.com", password: "faux" });
    }
    const security = (await allLogs()).filter((l) => l.category === "security");
    expect(security).toHaveLength(1);
    expect(security[0].metadata).toMatchObject({ ip: "198.51.100.0/24", limiter: "connexion" });
  });

  it("erreurs 5xx : route, statut, durée et nom de l'erreur — jamais le corps", async () => {
    const mini = express();
    mini.use(httpErrorLogger);
    mini.use(express.json());
    mini.post("/api/essai/:id", () => {
      throw new TypeError("Allergie-Secrete dans le message d'erreur");
    });
    // eslint-disable-next-line no-unused-vars
    mini.use((err, req, res, next) => {
      res.locals.errorName = err.name;
      res.status(500).json({ error: "Erreur serveur" });
    });
    const res = await request(mini).post("/api/essai/12?jeton=abc").send({ allergies: "Allergie-Secrete", title: "RDV-Secret" });
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 100)); // écriture « tirer et oublier »
    const [entry] = (await allLogs()).filter((l) => l.category === "http_error");
    expect(entry).toMatchObject({ level: "error", message: "Erreur serveur" });
    expect(entry.metadata).toMatchObject({ route: "/api/essai/:id", method: "POST", status: 500, errorName: "TypeError" });
    expect(typeof entry.metadata.durationMs).toBe("number");
    const dump = JSON.stringify(entry);
    expect(dump).not.toContain("Allergie-Secrete");
    expect(dump).not.toContain("RDV-Secret");
    expect(dump).not.toContain("jeton");
  });

  it("courriel échoué : destinataire masqué, ni objet ni contenu", async () => {
    // Serveur SMTP injoignable pendant les tests (port 1) : l'envoi échoue.
    await expect(sendAccountExistsEmail({ to: "yacine.diop@gmail.com", name: "Yacine" })).rejects.toThrow();
    const [entry] = (await allLogs()).filter((l) => l.category === "email");
    expect(entry).toMatchObject({ level: "error", message: "Échec d'envoi d'un courriel" });
    expect(entry.metadata.to).toBe("y***@gmail.com");
    expect(JSON.stringify(entry)).not.toContain("déjà un compte");
  });

  it("échec push : code d'erreur seulement, jamais l'adresse de l'abonnement ni le contenu", async () => {
    const before = { ...process.env };
    Object.assign(process.env, { VAPID_PUBLIC_KEY: "BCleDeTest", VAPID_PRIVATE_KEY: "clePriveeDeTest", VAPID_SUBJECT: "mailto:test@test.local" });
    webpush.sendNotification.mockRejectedValueOnce(Object.assign(new Error("abonnement-secret refusé"), { statusCode: 500, body: "abonnement-secret" }));
    try {
      const subscription = { id: 999, userId: awa.id, endpoint: "https://push.exemple/abonnement-secret", p256dh: "p", auth: "a", failures: 0 };
      expect(await sendToSubscription(subscription, { tag: "t", category: "x", title: "RDV-Secret" })).toBe(false);
    } finally {
      for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) process.env[k] = before[k] ?? "";
    }
    const [entry] = (await allLogs()).filter((l) => l.category === "push");
    expect(entry).toMatchObject({ level: "warn", message: "Échec d'envoi d'une notification push" });
    expect(entry.metadata).toMatchObject({ userId: awa.id, statusCode: 500 });
    const dump = JSON.stringify(entry);
    expect(dump).not.toContain("abonnement-secret");
    expect(dump).not.toContain("RDV-Secret");
  });

  it("passage du worker : durée, rappels, erreurs — sans donnée médicale", async () => {
    const family = await createFamily("Diop");
    const m = await addMembership(awa, family, "parent", { isPrimaryAdmin: true });
    const fiche = await createMember(family, "Yacine");
    await linkMember(m, fiche);
    await db.update(members).set({ allergies: "Allergie-Arachide-Z9" }).where(eq(members.id, fiche.id));
    await db.insert(appointments).values({ memberId: fiche.id, title: "RDV-Cardiologie-Z9", appointmentDate: new Date(Date.now() + 20 * 3600e3) });
    const result = await runWorkerCycle({ now: new Date(), sendMail: vi.fn(async () => "id") });
    expect(result.reminders).toBe(1);
    const [entry] = (await allLogs()).filter((l) => l.category === "worker");
    expect(entry).toMatchObject({ level: "info", message: "Passage du worker terminé" });
    expect(entry.metadata).toMatchObject({ reminders: 1, errors: 0 });
    expect(typeof entry.metadata.durationMs).toBe("number");
    const dump = JSON.stringify(await allLogs());
    expect(dump).not.toContain("RDV-Cardiologie-Z9");
    expect(dump).not.toContain("Allergie-Arachide-Z9");
  });

  it("une requête famille portant des données médicales ne laisse rien au journal", async () => {
    const family = await createFamily("Diop");
    await addMembership(awa, family, "parent", { isPrimaryAdmin: true });
    const fiche = await createMember(family, "Yacine");
    await as(awa).put(`/api/members/${fiche.id}`).send({ firstName: "Yacine", lastName: "Diop", allergies: "Allergie-Penicilline-Z9", notes: "Diabete-Z9" });
    const dump = JSON.stringify(await allLogs());
    expect(dump).not.toContain("Allergie-Penicilline-Z9");
    expect(dump).not.toContain("Diabete-Z9");
  });
});

describe("Rétention et consultation", () => {
  it("purge automatique après 90 jours", async () => {
    const now = new Date();
    await db.insert(technicalLogs).values([
      { level: "info", category: "auth", message: "Ancien", occurredAt: new Date(now.getTime() - 91 * 24 * 3600e3) },
      { level: "info", category: "auth", message: "Récent", occurredAt: new Date(now.getTime() - 89 * 24 * 3600e3) },
    ]);
    expect(await purgeTechnicalLogs(now)).toBe(1);
    expect((await allLogs()).map((l) => l.message)).toEqual(["Récent"]);
    // Le worker la fait à chaque passage.
    await db.insert(technicalLogs).values({ level: "info", category: "auth", message: "Très ancien", occurredAt: new Date(now.getTime() - 200 * 24 * 3600e3) });
    await runWorkerCycle({ now, sendMail: vi.fn(async () => "id") });
    expect((await allLogs()).some((l) => l.message === "Très ancien")).toBe(false);
  });

  it("page /admin/journaux : filtres (niveau, catégorie, période, recherche) et pagination, consultation auditée", async () => {
    const now = Date.now();
    await db.insert(technicalLogs).values(
      Array.from({ length: 60 }, (_, i) => ({
        level: i % 3 === 0 ? "error" : "info",
        category: i % 2 === 0 ? "email" : "auth",
        message: i === 7 ? "Message recherché" : `Entrée ${i}`,
        occurredAt: new Date(now - i * 60e3),
      }))
    );
    const support = await asSupport((await createSupport()).user);
    const page1 = await support.get("/api/admin/logs");
    expect(page1.body).toMatchObject({ total: 60, page: 1, pageSize: 50 });
    expect(page1.body.items).toHaveLength(50);
    expect((await support.get("/api/admin/logs?page=2")).body.items).toHaveLength(10);
    expect((await support.get("/api/admin/logs?category=email")).body.total).toBe(30);
    expect((await support.get("/api/admin/logs?level=error")).body.total).toBe(20);
    expect((await support.get("/api/admin/logs?q=recherch")).body.items.map((l) => l.message)).toEqual(["Message recherché"]);
    const from = new Date(now - 9.5 * 60e3).toISOString();
    expect((await support.get(`/api/admin/logs?from=${encodeURIComponent(from)}`)).body.total).toBe(10);
    const audit = await support.get("/api/admin/audit?action=logs_viewed");
    expect(audit.body.total).toBe(6);
  });
});
