import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { medicationIntakes, notifications } from "../db/schema.js";
import { NOTIFICATION_CATEGORIES, getAllPreferences, setPreference } from "../lib/notificationPreferences.js";

// Notifications de l'application (la cloche) et préférences par catégorie.
// Chaque compte ne voit et ne modifie que les siennes.
const router = Router();

router.get("/", async (req, res) => {
  try {
    const items = await db
      .select({
        id: notifications.id,
        category: notifications.category,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        memberId: notifications.memberId,
        intakeId: notifications.intakeId,
        intakeStatus: medicationIntakes.status,
        readAt: notifications.readAt,
        emailStatus: notifications.emailStatus,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .leftJoin(medicationIntakes, eq(medicationIntakes.id, notifications.intakeId))
      .where(and(eq(notifications.userId, req.user.id), eq(notifications.inApp, true)))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(50);
    res.json({ unreadCount: items.filter((n) => !n.readAt).length, items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/read-all", async (req, res) => {
  try {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, req.user.id), isNull(notifications.readAt)));
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/:id/read", async (req, res) => {
  try {
    const [updated] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, parseInt(req.params.id)), eq(notifications.userId, req.user.id)))
      .returning({ id: notifications.id });
    if (!updated) return res.status(404).json({ error: "Notification introuvable" });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Préférences (UC-65) : une ligne par catégorie, deux canaux par ligne,
// jamais d'interrupteur global.
router.get("/preferences", async (req, res) => {
  try {
    res.json(await getAllPreferences(req.user.id));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put("/preferences", async (req, res) => {
  try {
    const { category, inApp, email } = req.body;
    if (!NOTIFICATION_CATEGORIES[category] || typeof inApp !== "boolean" || typeof email !== "boolean") {
      return res.status(400).json({ error: "Catégorie ou canaux invalides" });
    }
    await setPreference(req.user.id, category, { inApp, email });
    res.json(await getAllPreferences(req.user.id));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
