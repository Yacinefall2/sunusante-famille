import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { familyMemberships, users } from "../db/schema.js";
import { logActivity } from "./activityLog.js";
import { notify } from "../reminders/notify.js";

// ── Mode senior (UC-25, M10 Accessibilité) ───────────────────────────────────
// « Le mode senior n'est pas un rôle, c'est un réglage d'affichage » : grands
// caractères, accueil simplifié, alertes sonores. Il n'a AUCUN effet sur les
// droits — aucune règle d'accès (lib/documentAccess.js) ne doit le lire.
// Chacun l'active ou le désactive pour lui-même ; un parent peut aussi le
// faire pour un autre compte adulte de sa famille (configuration initiale
// faite par un proche), la personne gardant la main pour le désactiver.

// Catégorie de la notification « un proche a changé votre affichage » : hors
// des préférences réglables (UC-65), toujours dans l'application, jamais par
// courriel (lib/notificationPreferences.js : catégorie inconnue → application seule).
export const DISPLAY_SETTINGS = "display_settings";

export const SENIOR_MODE_INVALID = "Valeur invalide : seniorMode doit valoir true ou false";

// Applique le réglage. `actor` : compte qui fait le changement ; `target` :
// compte concerné { id, name, emailVerified } ; `familyId` : famille dans
// laquelle un parent agit (null quand la personne agit pour elle-même — le
// journal est alors écrit dans chacune de ses familles). Renvoie l'état final.
export async function setSeniorMode({ actor, target, on, familyId = null }) {
  const [current] = await db.select({ seniorMode: users.seniorMode }).from(users).where(eq(users.id, target.id));
  if (!current) return null;
  if (current.seniorMode === on) return { seniorMode: on, changed: false };

  const now = new Date();
  await db
    .update(users)
    .set({ seniorMode: on, seniorModeSetByUserId: actor.id, seniorModeUpdatedAt: now })
    .where(eq(users.id, target.id));

  const forSomeoneElse = actor.id !== target.id;
  const familyIds = familyId
    ? [familyId]
    : (await db.select({ familyId: familyMemberships.familyId }).from(familyMemberships).where(eq(familyMemberships.userId, target.id))).map(
        (r) => r.familyId
      );
  for (const id of familyIds) {
    await logActivity({
      familyId: id,
      actor,
      action: "senior_mode_changed",
      target: forSomeoneElse ? target : null,
      details: { on },
      at: now,
    });
  }

  // La personne est prévenue quand un proche change son affichage.
  if (forSomeoneElse) {
    await notify({
      user: target,
      category: DISPLAY_SETTINGS,
      dedupeKey: `senior_mode:u${target.id}:${now.getTime()}`,
      title: `${actor.name} a ${on ? "activé" : "désactivé"} le mode senior pour vous`,
      body: on
        ? "Grands caractères, accueil simplifié et alertes sonores. Vous pouvez le désactiver dans Mon compte."
        : "Votre affichage redevient normal. Vous pouvez réactiver le mode senior dans Mon compte.",
      link: "/compte",
      familyId,
      memberId: null,
      now,
    });
  }
  return { seniorMode: on, changed: true };
}
