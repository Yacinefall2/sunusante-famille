import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { consentAttestations, documentRoles, members } from "../src/db/schema.js";
import { CONSENT_TEXT_VERSION } from "../src/lib/consent.js";
import { addDays, localDate } from "../src/lib/time.js";
import { resetDatabase, createUser, createFamily, addMembership, linkMember, grantRole, attest, attestation, as } from "./helpers.js";

// Attestation du consentement oral d'un proche majeur (UC-28, UC-29, UC-02,
// écran n°6, §10) : bloquante à la création, signalée sur les fiches
// existantes, retrait → fiche archivée, réactivation par un parent.
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendInvitationEmail: vi.fn(async () => {}),
}));

const yearsAgo = (y) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - y);
  d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
};

async function fiche(family, firstName, dateOfBirth, extra = {}) {
  const [m] = await db
    .insert(members)
    .values({ familyId: family.id, firstName, lastName: "Diallo", dateOfBirth, gender: "M", kinship: "autre", ...extra })
    .returning();
  return m;
}

// Foyer Diallo : Aïssatou (A1) et Moussa (A2), Fatou (adulte, sa fiche),
// Khady (adolescente, sa fiche).
let f;
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  const family = await createFamily("Diallo");
  const a1 = await createUser("Aïssatou Diallo");
  const a2 = await createUser("Moussa Diallo");
  const fatou = await createUser("Fatou Diallo");
  const khady = await createUser("Khady Diallo");
  const a1M = await addMembership(a1, family, "parent", { isPrimaryAdmin: true });
  const a2M = await addMembership(a2, family, "parent");
  const fatouM = await addMembership(fatou, family, "adult");
  const khadyM = await addMembership(khady, family, "adult");
  await linkMember(a1M, await fiche(family, "Aïssatou", "1980-03-01", { kinship: "parent", gender: "F" }));
  await linkMember(a2M, await fiche(family, "Moussa", "1978-03-01", { kinship: "parent" }));
  await linkMember(fatouM, await fiche(family, "Fatou", "1995-01-01", { gender: "F" }));
  await linkMember(khadyM, await fiche(family, "Khady", yearsAgo(16), { gender: "F", kinship: "enfant" }));
  f = { family, a1, a2, fatou, khady };
});

const proche = (extra = {}) => ({
  familyId: f.family.id,
  firstName: "Grand-père",
  lastName: "Diallo",
  dateOfBirth: "1945-05-05",
  gender: "M",
  kinship: "grand_parent",
  status: "non_connecte",
  ...extra,
});
const listed = async (user, m) => (await as(user).get(`/api/members?familyId=${f.family.id}`)).body.find((x) => x.id === m.id);
const consentRows = (m) => db.select().from(consentAttestations).where(eq(consentAttestations.memberId, m.id)).orderBy(consentAttestations.id);
const journal = async (user) => (await as(user).get(`/api/activity?familyId=${f.family.id}&category=consentement`)).body.entries;
const frDate = (iso) => iso.split("-").reverse().join("/");

describe("Création d'une fiche : attestation bloquante pour un proche majeur", () => {
  it("sans attestation : refusée (400, CONSENT_REQUIRED) et aucune fiche créée", async () => {
    const res = await as(f.a1).post("/api/members").send(proche());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CONSENT_REQUIRED");
    expect(await db.select().from(members).where(eq(members.firstName, "Grand-père"))).toHaveLength(0);
  });

  it("avec une attestation valide : fiche créée, attestation horodatée (déclarant, date, heure) et journal", async () => {
    const before = Date.now();
    const res = await as(f.a1).post("/api/members").send(proche({ consent: attestation(f.a1) }));
    expect(res.status).toBe(201);
    const [row] = await consentRows(res.body);
    expect(row).toMatchObject({
      kind: "attestation",
      familyId: f.family.id,
      memberName: "Grand-père Diallo",
      declarantUserId: f.a1.id,
      declarantName: "Aïssatou Diallo",
      signedName: "Aïssatou Diallo",
      method: "en_personne",
      intermediaryName: null,
      obtainedOn: localDate(),
      textVersion: CONSENT_TEXT_VERSION,
    });
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const [entry] = await journal(f.a1);
    expect(entry).toMatchObject({ action: "consent_attestation", category: "consentement", memberId: res.body.id });
    expect(entry.text).toBe(`Aïssatou Diallo a attesté l'accord oral de Grand-père Diallo (en personne, accord du ${frDate(localDate())})`);

    const seen = await listed(f.a1, res.body);
    expect(seen.consent).toMatchObject({
      required: false,
      attested: true,
      attestation: { declarantName: "Aïssatou Diallo", obtainedAt: localDate(), method: "en_personne" },
    });
    expect(seen.consent.attestation.attestedAt).toBeTruthy();
    // Le créateur reste gestionnaire de la fiche, comme avant.
    expect(seen.myDocumentRole).toBe("gestionnaire");
  });

  it("mineur : aucune attestation requise", async () => {
    const res = await as(f.a1).post("/api/members").send(proche({ firstName: "Petit", dateOfBirth: yearsAgo(10), kinship: "enfant", status: "mineur_gere" }));
    expect(res.status).toBe(201);
    expect(await consentRows(res.body)).toHaveLength(0);
    expect((await listed(f.a1, res.body)).consent).toMatchObject({ required: false, attested: false, attestation: null });
  });

  it("« Ma fiche » : pas d'attestation (la personne crée son propre dossier)", async () => {
    const omar = await createUser("Omar Diallo");
    await addMembership(omar, f.family, "adult");
    const res = await as(omar).post("/api/members").send(proche({ firstName: "Omar", dateOfBirth: "1990-01-01", kinship: "cousin", isMine: true }));
    expect(res.status).toBe(201);
    expect((await listed(omar, res.body)).consent).toMatchObject({ required: false });
  });

  it("signature : le nom complet du compte, sans tenir compte des accents, de la casse ni des espaces", async () => {
    const wrong = await as(f.a1).post("/api/members").send(proche({ consent: attestation(f.a1, { signedName: "Moussa Diallo" }) }));
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain("Aïssatou Diallo");
    const empty = await as(f.a1).post("/api/members").send(proche({ consent: attestation(f.a1, { signedName: "  " }) }));
    expect(empty.status).toBe(400);
    const ok = await as(f.a1).post("/api/members").send(proche({ consent: attestation(f.a1, { signedName: "  AISSATOU   diallo " }) }));
    expect(ok.status).toBe(201);
  });

  it("date de l'accord : ni dans le futur, ni plus d'un an avant, ni mal formée", async () => {
    const send = (obtainedOn) => as(f.a1).post("/api/members").send(proche({ consent: attestation(f.a1, { obtainedOn }) }));
    expect((await send(addDays(localDate(), 1))).status).toBe(400);
    expect((await send(addDays(localDate(), -400))).status).toBe(400);
    expect((await send("2026-02-30")).status).toBe(400);
    expect((await send(addDays(localDate(), -30))).status).toBe(201);
  });

  it("méthode : obligatoire et connue ; par un intermédiaire, son nom est obligatoire", async () => {
    const send = (extra) => as(f.a1).post("/api/members").send(proche({ consent: attestation(f.a1, extra) }));
    expect((await send({ method: "courrier" })).status).toBe(400);
    expect((await send({ method: "intermediaire" })).status).toBe(400);
    expect((await send({ method: "intermediaire", intermediaryName: "   " })).status).toBe(400);
    const ok = await send({ method: "intermediaire", intermediaryName: "Ibou Diallo" });
    expect(ok.status).toBe(201);
    expect((await consentRows(ok.body))[0]).toMatchObject({ method: "intermediaire", intermediaryName: "Ibou Diallo" });
    expect((await journal(f.a1))[0].text).toContain("par l'intermédiaire d'un proche (Ibou Diallo)");
    const phone = await send({ method: "telephone", intermediaryName: "ignoré" });
    expect((await consentRows(phone.body))[0]).toMatchObject({ method: "telephone", intermediaryName: null });
  });
});

describe("Fiches existantes : signalées, jamais bloquées", () => {
  it("fiche de proche majeur sans attestation : à attester, écritures possibles, élément « À traiter »", async () => {
    const papy = await fiche(f.family, "Papy", "1940-01-01", { status: "non_connecte" });
    await grantRole(papy, f.fatou, "gestionnaire");
    expect((await listed(f.a1, papy)).consent).toEqual({ required: true, attested: false, attestation: null });
    expect((await listed(f.fatou, papy)).consent.required).toBe(true);

    const put = await as(f.fatou).put("/api/members").send({ id: papy.id, firstName: "Papy", lastName: "Diallo", dateOfBirth: "1940-01-01", gender: "M", kinship: "autre", allergies: "Aucune" });
    expect(put.status).toBe(200);
    expect((await as(f.fatou).post("/api/appointments").send({ memberId: papy.id, title: "Contrôle", appointmentDate: "2030-01-01T10:00" })).status).toBe(201);

    const dash = (await as(f.a1).get(`/api/dashboard/family?familyId=${f.family.id}`)).body;
    expect(dash.todo).toContainEqual(
      expect.objectContaining({ type: "consent", severity: "warn", memberId: papy.id, title: "Consentement de Papy Diallo à attester" })
    );

    // Le gestionnaire atteste ensuite : plus rien à faire.
    const res = await as(f.fatou).post(`/api/members/${papy.id}/consent`).send(attestation(f.fatou, { method: "telephone" }));
    expect(res.status).toBe(201);
    expect((await listed(f.a1, papy)).consent).toMatchObject({ required: false, attested: true, attestation: { declarantName: "Fatou Diallo", method: "telephone" } });
    const after = (await as(f.a1).get(`/api/dashboard/family?familyId=${f.family.id}`)).body;
    expect(after.todo.some((t) => t.type === "consent")).toBe(false);
    expect((await journal(f.a1))[0].text).toBe(`Fatou Diallo a attesté l'accord oral de Papy Diallo (par téléphone, accord du ${frDate(localDate())})`);
  });

  it("âge inconnu (pas de date de naissance) : attestation requise", async () => {
    const x = await fiche(f.family, "Inconnu", null);
    expect((await listed(f.a1, x)).consent.required).toBe(true);
  });

  it("mineur sans compte, ou personne qui a son propre compte : rien à attester", async () => {
    const petit = await fiche(f.family, "Petit", yearsAgo(10), { kinship: "enfant" });
    expect((await listed(f.a1, petit)).consent.required).toBe(false);
    expect((await as(f.a1).post(`/api/members/${petit.id}/consent`).send(attestation(f.a1))).status).toBe(400);
    const fatouFiche = (await as(f.fatou).get(`/api/members?familyId=${f.family.id}`)).body.find((m) => m.isMine);
    expect(fatouFiche.consent.required).toBe(false);
    expect((await as(f.fatou).post(`/api/members/${fatouFiche.id}/consent`).send(attestation(f.fatou))).status).toBe(409);
  });

  it("une fois la fiche reliée au compte de la personne, plus d'attestation requise ; l'historique reste", async () => {
    const papy = await fiche(f.family, "Papy", "1940-01-01");
    await attest(papy, f.a1);
    const papyUser = await createUser("Papy Diallo");
    const m = await addMembership(papyUser, f.family, "adult");
    await linkMember(m, papy);
    expect((await listed(papyUser, papy)).consent).toMatchObject({ required: false, attested: true });
    expect(await consentRows(papy)).toHaveLength(1);
  });

  it("qui atteste : accès complet à la fiche, jamais un adolescent ni un simple lecteur", async () => {
    const papy = await fiche(f.family, "Papy", "1940-01-01");
    await grantRole(papy, f.khady, "lecteur_invite"); // rôle ancien, l'adolescente ne lit que sa fiche
    expect((await as(f.khady).post(`/api/members/${papy.id}/consent`).send(attestation(f.khady))).status).toBe(403);
    expect((await as(f.khady).post(`/api/members/${papy.id}/consent/withdraw`).send({})).status).toBe(403);
    expect((await as(f.khady).post("/api/members").send(proche({ consent: attestation(f.khady) }))).status).toBe(403);
    await grantRole(papy, f.fatou, "lecteur_invite");
    expect((await as(f.fatou).post(`/api/members/${papy.id}/consent`).send(attestation(f.fatou))).status).toBe(403);
    expect(await consentRows(papy)).toHaveLength(0);
  });
});

describe("Retrait de l'accord : la fiche est archivée", () => {
  it("retrait → archivée (consent_withdrawn), plus aucun accès, rôles retirés, journal", async () => {
    const papy = await fiche(f.family, "Papy", "1940-01-01", { status: "non_connecte" });
    await attest(papy, f.fatou);
    await grantRole(papy, f.fatou, "gestionnaire");
    const res = await as(f.fatou).post(`/api/members/${papy.id}/consent/withdraw`).send({});
    expect(res.status).toBe(200);

    const [after] = await db.select().from(members).where(eq(members.id, papy.id));
    expect(after.archivedAt).not.toBeNull();
    expect(after.archivedReason).toBe("consent_withdrawn");
    expect(after.archivedUserId).toBeNull();
    expect(await db.select().from(documentRoles).where(eq(documentRoles.memberId, papy.id))).toHaveLength(0);
    const rows = await consentRows(papy);
    expect(rows.map((r) => r.kind)).toEqual(["attestation", "withdrawal"]);
    expect(rows[1]).toMatchObject({ declarantUserId: f.fatou.id, declarantName: "Fatou Diallo" });

    for (const user of [f.a1, f.a2, f.fatou]) {
      const seen = await listed(user, papy);
      expect(seen).toMatchObject({ archived: true, archivedReason: "consent_withdrawn", access: null });
      expect(seen).not.toHaveProperty("consent");
      expect(seen).not.toHaveProperty("dateOfBirth");
      expect((await as(user).get(`/api/treatments?memberId=${papy.id}`)).status).toBe(403);
    }
    expect((await as(f.fatou).post(`/api/members/${papy.id}/consent/withdraw`).send({})).status).toBe(409);
    const [entry] = await journal(f.a1);
    expect(entry).toMatchObject({ action: "consent_withdrawn" });
    expect(entry.text).toBe("Fatou Diallo a enregistré le retrait de l'accord de Papy Diallo : sa fiche est archivée (1 rôle de dossier retiré)");
  });

  it("réactivation par un parent, avec une nouvelle attestation : désarchivée, il en devient gestionnaire", async () => {
    const papy = await fiche(f.family, "Papy", "1940-01-01");
    await grantRole(papy, f.fatou, "gestionnaire");
    expect((await as(f.fatou).post(`/api/members/${papy.id}/consent/withdraw`).send({})).status).toBe(200);

    // Un adulte non parent ne réactive pas ; une attestation invalide non plus.
    expect((await as(f.fatou).post(`/api/members/${papy.id}/consent`).send(attestation(f.fatou))).status).toBe(403);
    expect((await as(f.a2).post(`/api/members/${papy.id}/consent`).send(attestation(f.a2, { signedName: "X" }))).status).toBe(400);

    const res = await as(f.a2).post(`/api/members/${papy.id}/consent`).send(attestation(f.a2));
    expect(res.status).toBe(200);
    expect(res.body.reactivated).toBe(true);
    const [after] = await db.select().from(members).where(eq(members.id, papy.id));
    expect(after).toMatchObject({ archivedAt: null, archivedReason: null });
    const seen = await listed(f.a2, papy);
    expect(seen).toMatchObject({ archived: false, access: "full", myDocumentRole: "gestionnaire" });
    expect(seen.consent).toMatchObject({ required: false, attested: true, attestation: { declarantName: "Moussa Diallo" } });
    expect((await listed(f.fatou, papy)).access).toBeNull(); // ses rôles sont tombés avec l'archivage
    expect((await journal(f.a1))[0].text).toBe(
      `Moussa Diallo a réactivé la fiche de Papy Diallo, qui a redonné son accord oral (en personne, accord du ${frDate(localDate())}), et en est gestionnaire`
    );
  });

  it("une fiche archivée pour départ de son titulaire ne se réactive pas ainsi", async () => {
    const parti = await fiche(f.family, "Parti", "1990-01-01", { archivedAt: new Date(), archivedReason: "departure" });
    const res = await as(f.a1).post(`/api/members/${parti.id}/consent`).send(attestation(f.a1));
    expect(res.status).toBe(409);
    expect((await listed(f.a1, parti)).archivedReason).toBe("departure");
  });

  it("mineur ou personne avec compte : pas de retrait d'accord par la famille", async () => {
    const petit = await fiche(f.family, "Petit", yearsAgo(10), { kinship: "enfant" });
    expect((await as(f.a1).post(`/api/members/${petit.id}/consent/withdraw`).send({})).status).toBe(400);
    const fatouFiche = (await as(f.fatou).get(`/api/members?familyId=${f.family.id}`)).body.find((m) => m.isMine);
    expect((await as(f.a1).post(`/api/members/${fatouFiche.id}/consent/withdraw`).send({})).status).toBe(409);
  });
});

describe("Attestations ineffaçables", () => {
  it("UPDATE ou DELETE SQL direct refusé ; supprimées seulement avec la fiche", async () => {
    const papy = await fiche(f.family, "Papy", "1940-01-01");
    const row = await attest(papy, f.a1);
    await expect(db.update(consentAttestations).set({ method: "telephone" }).where(eq(consentAttestations.id, row.id))).rejects.toThrow();
    await expect(db.execute(sql`update consent_attestations set obtained_on = '2020-01-01' where id = ${row.id}`)).rejects.toThrow();
    await expect(db.delete(consentAttestations).where(eq(consentAttestations.id, row.id))).rejects.toThrow();
    // Compte du déclarant supprimé : son nom reste.
    const other = await createUser("Ibou Diallo");
    const otherM = await addMembership(other, f.family, "parent");
    const kept = await attest(papy, other);
    await db.execute(sql`delete from family_memberships where id = ${otherM.id}`);
    await db.execute(sql`delete from users where id = ${other.id}`);
    const [reread] = await db.select().from(consentAttestations).where(eq(consentAttestations.id, kept.id));
    expect(reread).toMatchObject({ declarantUserId: null, declarantName: "Ibou Diallo" });

    expect((await as(f.a1).delete(`/api/members?id=${papy.id}`)).status).toBe(200);
    expect(await db.select().from(consentAttestations).where(and(eq(consentAttestations.memberId, papy.id)))).toHaveLength(0);
  });
});

describe("Invitation (UC-02) : rôle de dossier sur un proche majeur", () => {
  it("refusée tant que l'accord oral n'est pas attesté (409, CONSENT_REQUIRED), acceptée ensuite", async () => {
    const papy = await fiche(f.family, "Papy", "1940-01-01");
    const body = { familyId: f.family.id, email: "relais@test.local", role: "adult", documentMemberId: papy.id, documentRole: "relais" };
    const refused = await as(f.a1).post("/api/invitations").send(body);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("CONSENT_REQUIRED");
    await attest(papy, f.a1);
    expect((await as(f.a1).post("/api/invitations").send(body)).status).toBe(201);
  });

  it("mineur : aucune attestation exigée pour un rôle sur son dossier", async () => {
    const petit = await fiche(f.family, "Petit", yearsAgo(10), { kinship: "enfant" });
    const res = await as(f.a1)
      .post("/api/invitations")
      .send({ familyId: f.family.id, email: "tata@test.local", role: "adult", documentMemberId: petit.id, documentRole: "relais" });
    expect(res.status).toBe(201);
  });
});
