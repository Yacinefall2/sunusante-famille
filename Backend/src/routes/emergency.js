import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { emergencyCards, emergencyCardViews, members } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdFromMemberId } from "../lib/familyResolvers.js";
import { canReadMember, canWriteMember } from "../lib/documentAccess.js";
import { canComposeEmergency, EMERGENCY_FIELDS, emergencyPublicView, frontendUrl, newToken } from "../lib/sharing.js";

// Fiche d'urgence (A6, UC-24/38) : composée champ par champ. Rien n'est
// publié par défaut ; le QR code imprimé pointe vers le jeton de la fiche.
const router = Router();

const membershipFor = requireFamilyMembership((req) => familyIdFromMemberId(req.params.memberId));

async function load(req, res) {
  const memberId = parseInt(req.params.memberId);
  const [member] = await db.select().from(members).where(eq(members.id, memberId));
  if (!member) {
    res.status(404).json({ error: "Fiche introuvable" });
    return null;
  }
  if (!(await canReadMember(req, memberId))) {
    res.status(403).json({ error: "Accès refusé à ce dossier" });
    return null;
  }
  const [card] = await db.select().from(emergencyCards).where(eq(emergencyCards.memberId, memberId));
  const canEdit = await canComposeEmergency(req, member, await canWriteMember(req, memberId));
  return { member, card: card ?? null, canEdit };
}

async function describe({ member, card, canEdit }) {
  const settings = card ?? { active: false, extraInfo: null, ...Object.fromEntries(EMERGENCY_FIELDS.map((f) => [f, false])) };
  const views = card
    ? await db
        .select({ viewedAt: emergencyCardViews.viewedAt })
        .from(emergencyCardViews)
        .where(eq(emergencyCardViews.cardId, card.id))
        .orderBy(desc(emergencyCardViews.viewedAt))
        .limit(20)
    : [];
  return {
    memberId: member.id,
    canEdit,
    active: settings.active,
    extraInfo: settings.extraInfo,
    fields: Object.fromEntries(EMERGENCY_FIELDS.map((f) => [f, settings[f]])),
    // Seul celui qui compose la fiche obtient le lien du QR code.
    url: canEdit && card ? `${frontendUrl()}/urgence/${card.token}` : null,
    // Aperçu « ce que verra un inconnu », avec les réglages enregistrés.
    preview: settings.active ? await emergencyPublicView(settings, member) : null,
    views,
    updatedAt: card?.updatedAt ?? null,
  };
}

router.get("/:memberId", membershipFor, async (req, res) => {
  try {
    const ctx = await load(req, res);
    if (ctx) res.json(await describe(ctx));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put("/:memberId", membershipFor, async (req, res) => {
  try {
    const ctx = await load(req, res);
    if (!ctx) return;
    if (!ctx.canEdit) return res.status(403).json({ error: "Seul le titulaire compose sa fiche d'urgence" });
    const values = { active: Boolean(req.body.active), updatedByUserId: req.user.id, updatedAt: new Date() };
    for (const f of EMERGENCY_FIELDS) values[f] = Boolean(req.body.fields?.[f]);
    const extra = typeof req.body.extraInfo === "string" ? req.body.extraInfo.trim().slice(0, 300) : "";
    values.extraInfo = extra || null;
    if (values.active && !EMERGENCY_FIELDS.some((f) => values[f]) && !values.extraInfo) {
      return res.status(400).json({ error: "Cochez au moins une information avant d'activer la fiche d'urgence" });
    }
    const [card] = ctx.card
      ? await db.update(emergencyCards).set(values).where(eq(emergencyCards.id, ctx.card.id)).returning()
      : await db.insert(emergencyCards).values({ ...values, memberId: ctx.member.id, token: newToken() }).returning();
    res.json(await describe({ ...ctx, card }));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Nouveau QR code : l'ancien lien (et donc la carte déjà imprimée) cesse de fonctionner.
router.post("/:memberId/regenerate", membershipFor, async (req, res) => {
  try {
    const ctx = await load(req, res);
    if (!ctx) return;
    if (!ctx.canEdit) return res.status(403).json({ error: "Seul le titulaire compose sa fiche d'urgence" });
    if (!ctx.card) return res.status(400).json({ error: "Enregistrez d'abord la fiche d'urgence" });
    const [card] = await db
      .update(emergencyCards)
      .set({ token: newToken(), updatedByUserId: req.user.id, updatedAt: new Date() })
      .where(eq(emergencyCards.id, ctx.card.id))
      .returning();
    res.json(await describe({ ...ctx, card }));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
