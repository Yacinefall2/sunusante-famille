import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { members, notifications, users } from "../src/db/schema.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, seedMedicalData, as } from "./helpers.js";

// Mode senior (UC-25, M10 Accessibilité) : un réglage d'affichage, pas un
// rôle. Activable par la personne elle-même ou par un parent de sa famille,
// tracé au journal, et sans AUCUN effet sur les droits.

// Foyer Fall : Mouhamed (A1), Dior (A2), Mamadou (68 ans, adulte, sa fiche),
// Toutou (adolescente, sa fiche). Famille Ndiaye à part : Awa (A1).
let f;
beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Fall");
  const [mouhamed, dior, mamadou, toutou] = await Promise.all(
    ["Mouhamed Fall", "Dior Fall", "Mamadou Fall", "Toutou Fall"].map((n) => createUser(n))
  );
  const mm = await addMembership(mouhamed, family, "parent", { isPrimaryAdmin: true });
  const dm = await addMembership(dior, family, "parent");
  const sm = await addMembership(mamadou, family, "adult");
  const tm = await addMembership(toutou, family, "adult");
  const fiche = async (firstName, dateOfBirth, membership) => {
    const m = await createMember(family, firstName);
    await db.update(members).set({ lastName: "Fall", dateOfBirth }).where(eq(members.id, m.id));
    await linkMember(membership, m);
    return m;
  };
  const fMouhamed = await fiche("Mouhamed", "1966-12-11", mm);
  await fiche("Dior", "1976-04-22", dm);
  const fMamadou = await fiche("Mamadou", "1958-03-01", sm);
  await fiche("Toutou", "2011-08-25", tm); // 15 ans : adolescente
  await seedMedicalData(fMamadou);
  await seedMedicalData(fMouhamed);

  const other = await createFamily("Ndiaye");
  const awa = await createUser("Awa Ndiaye");
  await addMembership(awa, other, "parent", { isPrimaryAdmin: true });
  f = { family, mouhamed, dior, mamadou, toutou, mm, dm, sm, tm, fMamadou, fMouhamed, awa };
});

const seniorOf = async (user) => (await db.select({ s: users.seniorMode }).from(users).where(eq(users.id, user.id)))[0].s;
const texts = async (user) => {
  const res = await as(user).get(`/api/activity?familyId=${f.family.id}`);
  expect(res.status).toBe(200);
  return res.body.entries.map((e) => e.text);
};

describe("Pour soi-même", () => {
  it("activer puis désactiver dans « Mon compte » ; /me et /api/account renvoient le réglage", async () => {
    expect((await as(f.mamadou).get("/api/auth/me")).body.seniorMode).toBe(false);

    const on = await as(f.mamadou).put("/api/account/display").send({ seniorMode: true });
    expect(on.status).toBe(200);
    expect(on.body.seniorMode).toBe(true);
    expect((await as(f.mamadou).get("/api/auth/me")).body.seniorMode).toBe(true);
    const account = (await as(f.mamadou).get("/api/account")).body;
    expect(account.seniorMode).toBe(true);
    expect(account.seniorModeSetBy).toBeNull(); // réglé par lui-même

    expect((await as(f.mamadou).put("/api/account/display").send({ seniorMode: false })).body.seniorMode).toBe(false);
    expect(await seniorOf(f.mamadou)).toBe(false);
  });

  it("valeur invalide refusée", async () => {
    expect((await as(f.mamadou).put("/api/account/display").send({ seniorMode: "oui" })).status).toBe(400);
    expect((await as(f.mamadou).put("/api/account/display").send({})).status).toBe(400);
  });

  it("journal : « X a activé le mode senior », une seule fois tant que rien ne change, sans notification", async () => {
    await as(f.mamadou).put("/api/account/display").send({ seniorMode: true });
    await as(f.mamadou).put("/api/account/display").send({ seniorMode: true });
    const t = await texts(f.mouhamed);
    expect(t.filter((x) => x === "Mamadou Fall a activé le mode senior")).toHaveLength(1);
    expect(await db.select().from(notifications).where(eq(notifications.userId, f.mamadou.id))).toHaveLength(0);
  });
});

describe("Par un parent, pour un proche", () => {
  it("un parent l'active pour un adulte de sa famille : la personne est notifiée, le journal le dit", async () => {
    const res = await as(f.mouhamed).put(`/api/family-memberships/${f.sm.id}/senior-mode`).send({ seniorMode: true });
    expect(res.status).toBe(200);
    expect(res.body.seniorMode).toBe(true);
    expect(await seniorOf(f.mamadou)).toBe(true);

    // Visible dans la liste des comptes (interrupteur de la ligne)
    const list = (await as(f.mouhamed).get(`/api/family-memberships?familyId=${f.family.id}`)).body;
    expect(list.find((m) => m.id === f.sm.id).seniorMode).toBe(true);

    // Notification in-app à la personne, jamais par courriel
    const notifs = await db.select().from(notifications).where(eq(notifications.userId, f.mamadou.id));
    expect(notifs).toHaveLength(1);
    expect(notifs[0].title).toBe("Mouhamed Fall a activé le mode senior pour vous");
    expect(notifs[0].body).toMatch(/désactiver dans Mon compte/);
    expect(notifs[0].inApp).toBe(true);
    expect(notifs[0].emailStatus).toBe("skipped");
    expect((await as(f.mamadou).get("/api/notifications")).body.items[0].category).toBe("display_settings");

    expect(await texts(f.mouhamed)).toContain("Mouhamed Fall a activé le mode senior pour Mamadou Fall");
    expect((await as(f.mamadou).get("/api/account")).body.seniorModeSetBy).toBe("Mouhamed Fall");

    // La personne garde la main : elle le désactive elle-même.
    expect((await as(f.mamadou).put("/api/account/display").send({ seniorMode: false })).body.seniorMode).toBe(false);
    expect(await texts(f.mouhamed)).toContain("Mamadou Fall a désactivé le mode senior");
  });

  it("autorisé aussi pour l'autre parent (réglage d'affichage, sans enjeu de droits)", async () => {
    const res = await as(f.dior).put(`/api/family-memberships/${f.mm.id}/senior-mode`).send({ seniorMode: true });
    expect(res.status).toBe(200);
    expect(await seniorOf(f.mouhamed)).toBe(true);
  });

  it("un non-parent ne peut pas le régler pour quelqu'un d'autre", async () => {
    const res = await as(f.mamadou).put(`/api/family-memberships/${f.mm.id}/senior-mode`).send({ seniorMode: true });
    expect(res.status).toBe(403);
    expect(await seniorOf(f.mouhamed)).toBe(false);
    expect((await as(f.toutou).put(`/api/family-memberships/${f.sm.id}/senior-mode`).send({ seniorMode: true })).status).toBe(403);
    expect(await seniorOf(f.mamadou)).toBe(false);
  });

  it("pas pour un compte d'une autre famille", async () => {
    const res = await as(f.awa).put(`/api/family-memberships/${f.sm.id}/senior-mode`).send({ seniorMode: true });
    expect(res.status).toBe(403);
    expect(await seniorOf(f.mamadou)).toBe(false);
    expect(await db.select().from(notifications).where(eq(notifications.userId, f.mamadou.id))).toHaveLength(0);
  });

  it("pas pour un compte adolescent ; valeur invalide refusée", async () => {
    expect((await as(f.mouhamed).put(`/api/family-memberships/${f.tm.id}/senior-mode`).send({ seniorMode: true })).status).toBe(403);
    expect(await seniorOf(f.toutou)).toBe(false);
    expect((await as(f.mouhamed).put(`/api/family-memberships/${f.sm.id}/senior-mode`).send({ seniorMode: 1 })).status).toBe(400);
  });
});

describe("Aucun effet sur les droits", () => {
  // Tout ce que le compte peut lire ou faire, avant et après activation.
  const snapshot = async (user) => {
    const q = `familyId=${f.family.id}`;
    const get = async (url) => {
      const r = await as(user).get(url);
      return { status: r.status, body: r.body };
    };
    return {
      members: await get(`/api/members?${q}`),
      appointments: await get(`/api/appointments?${q}`),
      treatments: await get(`/api/treatments?${q}`),
      vaccinations: await get(`/api/vaccinations?${q}`),
      documents: await get(`/api/documents?${q}`),
      dashboard: await get(`/api/dashboard?${q}`),
      autreFiche: await get(`/api/treatments?memberId=${f.fMouhamed.id}`),
      familyDashboard: (await as(user).get(`/api/dashboard/family?${q}`)).status,
    };
  };

  it("un compte en mode senior garde exactement le même accès (adulte, puis parent)", async () => {
    for (const user of [f.mamadou, f.mouhamed]) {
      const before = await snapshot(user);
      await as(user).put("/api/account/display").send({ seniorMode: true });
      expect(await seniorOf(user)).toBe(true);
      expect(await snapshot(user)).toEqual(before);
    }
    // Réglé par un parent : idem, et le rôle d'espace ne bouge pas.
    await as(f.mamadou).put("/api/account/display").send({ seniorMode: false });
    const before = await snapshot(f.mamadou);
    await as(f.mouhamed).put(`/api/family-memberships/${f.sm.id}/senior-mode`).send({ seniorMode: true });
    expect(await snapshot(f.mamadou)).toEqual(before);
    const list = (await as(f.mouhamed).get(`/api/family-memberships?familyId=${f.family.id}`)).body;
    expect(list.find((m) => m.id === f.sm.id).role).toBe("adult");
    // L'adulte n'obtient pas de droits de parent : toujours refusé.
    expect((await as(f.mamadou).put(`/api/family-memberships/${f.mm.id}/senior-mode`).send({ seniorMode: false })).status).toBe(403);
    expect(
      await db.select().from(notifications).where(and(eq(notifications.userId, f.mouhamed.id), eq(notifications.category, "display_settings")))
    ).toHaveLength(0);
  });
});
