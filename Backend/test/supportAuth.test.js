import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app.js";
import { db } from "../src/db/index.js";
import { supportAudit, supportSessions, supportUsers } from "../src/db/schema.js";
import { createSupportUser, deactivateSupportUser, resetSupportTotp } from "../src/lib/supportAccounts.js";
import { base32Encode, decryptTotpSecret, hotp, stepAt, totpCode, verifyTotp } from "../src/lib/totp.js";
import { signAccessToken } from "../src/lib/jwt.js";
import { resetDatabase, createUser, as, asSupport } from "./helpers.js";

// Comptes support (A5) : création en ligne de commande, connexion par mot de
// passe + code TOTP, session séparée de celle des familles.

let created;

beforeEach(async () => {
  await resetDatabase();
  created = await createSupportUser({ email: "Agent@Support.local", name: "Awa Ndiaye" });
});

const login = (body, ip) => {
  const r = request(app).post("/api/admin/auth/login");
  if (ip) r.set("X-Forwarded-For", ip);
  return r.send(body);
};
const goodLogin = (extra = {}) =>
  login({ email: "agent@support.local", password: created.password, code: totpCode(created.secret), ...extra });
// Prochain pas de temps : un code neuf (le précédent est « déjà utilisé »).
const nextCode = () => hotp(created.secret, stepAt() + 1);

describe("Codes TOTP (RFC 6238)", () => {
  it("respecte les vecteurs de test de la RFC (SHA-1)", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(totpCode(secret, 59 * 1000)).toBe("287082");
    expect(totpCode(secret, 1111111109 * 1000)).toBe("081804");
    expect(totpCode(secret, 2000000000 * 1000)).toBe("279037");
  });

  it("accepte ±1 pas de 30 s, refuse au-delà et refuse un pas déjà utilisé", () => {
    const now = Date.now();
    const step = stepAt(now);
    expect(verifyTotp(created.secret, hotp(created.secret, step - 1), { time: now })).toBe(step - 1);
    expect(verifyTotp(created.secret, hotp(created.secret, step + 1), { time: now })).toBe(step + 1);
    expect(verifyTotp(created.secret, hotp(created.secret, step - 2), { time: now })).toBeNull();
    expect(verifyTotp(created.secret, hotp(created.secret, step), { time: now, lastStep: step })).toBeNull();
    expect(verifyTotp(created.secret, "12345", { time: now })).toBeNull();
  });
});

describe("Création par la commande serveur", () => {
  it("crée le compte avec un mot de passe fort et un secret TOTP chiffré", async () => {
    expect(created.password.length).toBeGreaterThanOrEqual(16);
    expect(created.user.email).toBe("agent@support.local");
    expect(created.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(created.otpauthUrl).toContain(`secret=${created.secret}`);
    const [row] = await db.select().from(supportUsers).where(eq(supportUsers.id, created.user.id));
    expect(row.totpSecretEncrypted).not.toContain(created.secret);
    expect(row.passwordHash).not.toBe(created.password);
    expect(decryptTotpSecret(row.totpSecretEncrypted, row.email)).toBe(created.secret);
    // Recopié sur un autre compte, le chiffré ne se déchiffre pas.
    expect(decryptTotpSecret(row.totpSecretEncrypted, "autre@support.local")).toBeNull();
    const audit = await db.select().from(supportAudit);
    expect(audit.map((a) => a.action)).toContain("support_user_created");
  });

  it("refuse une adresse déjà prise, invalide, ou un nom vide", async () => {
    await expect(createSupportUser({ email: "agent@support.local", name: "X" })).rejects.toThrow(/existe déjà/);
    await expect(createSupportUser({ email: "pas-une-adresse", name: "X" })).rejects.toThrow(/invalide/);
    await expect(createSupportUser({ email: "b@support.local", name: " " })).rejects.toThrow(/Nom requis/);
    await expect(createSupportUser({ email: "c@support.local", name: "C", password: "court" })).rejects.toThrow(/16 caractères/);
  });

  it("désactiver ferme les sessions et empêche la connexion", async () => {
    const support = await asSupport(created.user);
    expect((await support.get("/api/admin/auth/me")).status).toBe(200);
    await deactivateSupportUser("agent@support.local");
    expect((await support.get("/api/admin/auth/me")).status).toBe(401);
    expect((await goodLogin()).status).toBe(401);
  });

  it("réinitialiser le double facteur rend l'ancien secret inutilisable", async () => {
    const reset = await resetSupportTotp("agent@support.local");
    expect(reset.secret).not.toBe(created.secret);
    expect((await goodLogin()).status).toBe(401);
    const ok = await login({ email: "agent@support.local", password: created.password, code: totpCode(reset.secret) });
    expect(ok.status).toBe(200);
  });
});

describe("Connexion : mot de passe + code", () => {
  it("connexion réussie : cookie admin_token httpOnly, SameSite=Strict, limité à /api/admin, auditée", async () => {
    const res = await goodLogin();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: "agent@support.local", name: "Awa Ndiaye" });
    const cookie = res.headers["set-cookie"].find((c) => c.startsWith("admin_token="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/admin/);
    expect(cookie).toMatch(/Max-Age=1800/);
    // Ni jeton d'accès famille, ni jeton de rafraîchissement.
    expect(res.headers["set-cookie"].some((c) => c.startsWith("access_token=") || c.startsWith("refresh_token="))).toBe(false);
    const me = await request(app).get("/api/admin/auth/me").set("Cookie", cookie.split(";")[0]);
    expect(me.status).toBe(200);
    const audit = await db.select().from(supportAudit).where(eq(supportAudit.action, "login_success"));
    expect(audit).toHaveLength(1);
    expect(audit[0].supportUserId).toBe(created.user.id);
  });

  it("code invalide, mot de passe faux, code manquant : refusés (même message), échecs audités", async () => {
    expect((await goodLogin({ code: hotp(created.secret, stepAt() + 5) })).status).toBe(401);
    const wrongPassword = await goodLogin({ password: "mauvais-mot-de-passe" });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error).toBe("Identifiants ou code invalides");
    expect((await goodLogin({ email: "inconnu@support.local" })).body.error).toBe("Identifiants ou code invalides");
    expect((await goodLogin({ code: "" })).status).toBe(400);
    const failures = await db.select().from(supportAudit).where(eq(supportAudit.action, "login_failed"));
    expect(failures).toHaveLength(3);
    expect(JSON.stringify(failures)).not.toContain("mauvais-mot-de-passe");
  });

  it("un code ne sert qu'une fois", async () => {
    const code = totpCode(created.secret);
    expect((await goodLogin({ code })).status).toBe(200);
    expect((await goodLogin({ code })).status).toBe(401); // même code, réutilisé
    expect((await goodLogin({ code: nextCode() })).status).toBe(200); // pas suivant : accepté
  });

  it("5 échecs bloquent 15 minutes, même avec les bons identifiants", async () => {
    for (let i = 0; i < 5; i++) expect((await goodLogin({ password: "faux-faux-faux" })).status).toBe(401);
    const blocked = await goodLogin();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/15 minutes/);
  });

  it("déconnexion : la session est fermée", async () => {
    const res = await goodLogin();
    const cookie = res.headers["set-cookie"].find((c) => c.startsWith("admin_token=")).split(";")[0];
    expect((await request(app).post("/api/admin/auth/logout").set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).get("/api/admin/auth/me").set("Cookie", cookie)).status).toBe(401);
  });

  it("session glissante de 30 minutes : expirée, elle est refusée", async () => {
    const support = await asSupport(created.user);
    expect((await support.get("/api/admin/dashboard")).status).toBe(200);
    await db.update(supportSessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await support.get("/api/admin/dashboard")).status).toBe(401);
  });

  it("chaque requête prolonge la session de 30 minutes", async () => {
    const support = await asSupport(created.user);
    await db.update(supportSessions).set({ expiresAt: new Date(Date.now() + 60 * 1000) });
    await support.get("/api/admin/auth/me");
    const [session] = await db.select().from(supportSessions);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 60 * 1000);
  });
});

describe("Sessions séparées", () => {
  it("une session famille n'ouvre jamais /api/admin", async () => {
    const user = await createUser("Famille");
    const family = as(user);
    expect((await family.get("/api/admin/dashboard")).status).toBe(401);
    expect((await family.get("/api/admin/auth/me")).status).toBe(401);
    expect((await family.get("/api/admin/accounts?q=Fa")).status).toBe(401);
    // Même un jeton famille glissé dans le cookie admin est refusé.
    const forged = await request(app).get("/api/admin/dashboard").set("Cookie", `admin_token=${signAccessToken(user)}`);
    expect(forged.status).toBe(401);
  });

  it("une session support n'ouvre jamais les routes famille", async () => {
    const support = await asSupport(created.user);
    expect((await support.get("/api/account")).status).toBe(401);
    expect((await support.get("/api/families")).status).toBe(401);
    expect((await support.get("/api/auth/me")).status).toBe(401);
    expect((await support.get("/api/support/requests")).status).toBe(401);
    // Le jeton support présenté comme jeton d'accès famille : refusé aussi.
    const token = support.cookie.split("=")[1];
    expect((await request(app).get("/api/account").set("Cookie", `access_token=${token}`)).status).toBe(401);
  });
});
