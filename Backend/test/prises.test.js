import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { medicationIntakes, notifications, treatmentMedications, treatments } from "../src/db/schema.js";
import { runReminderTick } from "../src/reminders/engine.js";
import { resetDatabase, createUser, createFamily, addMembership, createMember, linkMember } from "./helpers.js";

// Fuseau de référence Africa/Dakar (UTC+0) : heures identiques en UTC.
const at = (iso) => new Date(iso);
const tick = (now) => runReminderTick({ now, sendMail: async () => "<id>" });

let f;
beforeEach(async () => {
  await resetDatabase();
  const family = await createFamily("Ndiaye");
  const awa = await createUser("Awa");
  const fiche = await createMember(family, "Awa");
  await linkMember(await addMembership(awa, family, "parent", { isPrimaryAdmin: true }), fiche);
  const [t] = await db.insert(treatments).values({ memberId: fiche.id, disease: "Hypertension", isActive: true, createdAt: at("2026-11-01T00:00:00Z") }).returning();
  const [med] = await db
    .insert(treatmentMedications)
    .values({ treatmentId: t.id, name: "Amlodipine", intakeTimes: ["08:00", "23:30"], createdAt: at("2026-11-01T00:00:00Z") })
    .returning();
  f = { awa, fiche, t, med };
});

const intakeNotifs = async () => db.select().from(notifications).where(eq(notifications.userId, f.awa.id));

describe("Prises de médicament (point 17)", () => {
  it("traitement arrêté après le rappel : pas de relance", async () => {
    await tick(at("2026-11-10T08:01:00Z"));
    expect(await intakeNotifs()).toHaveLength(1);
    await db.update(treatments).set({ isActive: false }).where(eq(treatments.id, f.t.id));
    await tick(at("2026-11-10T08:40:00Z"));
    expect(await intakeNotifs()).toHaveLength(1); // pas de relance
  });

  it("heure retirée du médicament : la prise jamais rappelée n'est pas rappelée", async () => {
    // La prise de 08:00 est créée mais pas encore rappelée (simulé), puis l'heure est retirée.
    await db.insert(medicationIntakes).values({ medicationId: f.med.id, memberId: f.fiche.id, scheduledAt: at("2026-11-10T08:00:00Z") });
    await db.update(treatmentMedications).set({ intakeTimes: ["23:30"] }).where(eq(treatmentMedications.id, f.med.id));
    await tick(at("2026-11-10T08:05:00Z"));
    expect(await intakeNotifs()).toHaveLength(0);
    const left = (await db.select().from(medicationIntakes)).map((i) => i.scheduledAt.toISOString());
    expect(left).not.toContain("2026-11-10T08:00:00.000Z");
  });

  it("moteur arrêté à minuit : la prise de 23:30 de la veille est rattrapée", async () => {
    await tick(at("2026-11-11T00:30:00Z"));
    const rows = await db.select().from(medicationIntakes).where(eq(medicationIntakes.medicationId, f.med.id));
    const late = rows.find((r) => r.scheduledAt.toISOString() === "2026-11-10T23:30:00.000Z");
    expect(late.status).toBe("pending");
    expect(late.remindedAt).not.toBeNull();
    // La prise de 08:00 de la veille, trop ancienne pour un rappel, est enregistrée « sans réponse ».
    expect(rows.find((r) => r.scheduledAt.toISOString() === "2026-11-10T08:00:00.000Z").status).toBe("missed");
  });
});
