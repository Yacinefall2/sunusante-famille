import { Router } from "express";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdFromBody, familyIdFromQuery } from "../lib/familyResolvers.js";
import {
  DEFAULT_REMINDER_SETTINGS,
  REMINDER_BOUNDS,
  getReminderSettings,
  resetReminderSettings,
  saveReminderSettings,
  validateReminderSettings,
} from "../lib/reminderSettings.js";
import { logActivity } from "../lib/activityLog.js";

// Règles d'escalade des rappels du Village (UC-08) — lecture et
// modification réservées aux parents (A1, A2). DELETE rétablit les valeurs
// par défaut (celles du cycle d'origine).
const router = Router();

const parentsOnly = { roles: ["parent"] };
const payload = (settings) => ({ ...settings, defaults: DEFAULT_REMINDER_SETTINGS, bounds: REMINDER_BOUNDS });

router.get("/", requireFamilyMembership(familyIdFromQuery, parentsOnly), async (req, res) => {
  try {
    res.json(payload(await getReminderSettings(req.familyId)));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put("/", requireFamilyMembership(familyIdFromBody, parentsOnly), async (req, res) => {
  try {
    const { value, error } = validateReminderSettings(req.body);
    if (error) return res.status(400).json({ error });
    const saved = await saveReminderSettings(req.familyId, value, req.user.id);
    await logActivity({ familyId: req.familyId, actor: req.user, action: "reminder_settings_updated", details: value });
    res.json(payload(saved));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.delete("/", requireFamilyMembership(familyIdFromQuery, parentsOnly), async (req, res) => {
  try {
    const before = await getReminderSettings(req.familyId);
    const settings = await resetReminderSettings(req.familyId);
    if (!before.isDefault) {
      await logActivity({ familyId: req.familyId, actor: req.user, action: "reminder_settings_reset", details: { ...DEFAULT_REMINDER_SETTINGS } });
    }
    res.json(payload(settings));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
