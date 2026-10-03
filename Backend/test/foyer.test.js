import { describe, it, expect, beforeEach } from "vitest";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember, grantRole, as } from "./helpers.js";

// Cas réel : 4 membres (dont un sans compte) et 3 comptes ; le membre
// « adulte » ne lit que sa propre fiche et relaie pour le proche sans compte.
let f;
beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("FALL");
  const [yacine, zahra, yass, invite] = await Promise.all(["yacine", "zahra", "yassfall", "invité"].map((n) => createUser(n)));
  const ym = await addMembership(yacine, family, "parent", { isPrimaryAdmin: true });
  const zm = await addMembership(zahra, family, "parent");
  const sm = await addMembership(yass, family, "adult");
  await addMembership(invite, family, "adult"); // compte sans fiche (pas encore « Ma fiche »)
  const fiches = {
    mouhamed: await createMember(family, "Mouhamed"),
    zahra: await createMember(family, "zahra"),
    yass: await createMember(family, "Yass"),
    yacineFall: await createMember(family, "Yacine"),
  };
  await linkMember(ym, fiches.mouhamed);
  await linkMember(zm, fiches.zahra);
  await linkMember(sm, fiches.yass);
  await grantRole(fiches.yacineFall, yass, "relais");
  f = { family, yacine, zahra, yass, fiches };
});

describe("Membres, comptes et fiches sans ambiguïté", () => {
  it("le tableau de bord compte tous les membres du foyer, même ceux dont on ne lit pas la fiche", async () => {
    const res = await as(f.yass).get(`/api/dashboard?familyId=${f.family.id}`);
    expect(res.body.membersCount).toBe(4);
    expect(res.body.readableCount).toBe(1);
  });

  it("le foyer : 4 membres, 4 comptes dont 1 sans fiche", async () => {
    const res = await as(f.yass).get(`/api/members/household?familyId=${f.family.id}`);
    expect(res.body).toMatchObject({ membersCount: 4, accountsCount: 4 });
    expect(res.body.accountsWithoutFiche.map((a) => a.name)).toEqual(["invité"]);
  });

  it("chaque membre porte son compte et son rôle dans la famille, visibles de tous", async () => {
    const list = (await as(f.yass).get(`/api/members?familyId=${f.family.id}`)).body;
    const byId = Object.fromEntries(list.map((m) => [m.id, m]));
    expect(byId[f.fiches.mouhamed.id].account).toMatchObject({ name: "yacine", role: "parent", isPrimaryAdmin: true });
    expect(byId[f.fiches.zahra.id].account).toMatchObject({ name: "zahra", role: "parent", isPrimaryAdmin: false });
    expect(byId[f.fiches.yass.id].account).toMatchObject({ name: "yassfall", role: "adult" });
    expect(byId[f.fiches.yacineFall.id].account).toBeNull();
    expect(byId[f.fiches.yacineFall.id]).toMatchObject({ myDocumentRole: "relais", access: "relay" });
    expect(byId[f.fiches.mouhamed.id]).not.toHaveProperty("allergies"); // le compte, oui ; le dossier, non
  });
});
