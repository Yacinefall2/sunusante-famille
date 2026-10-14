import { count, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifications } from "../db/schema.js";
import { runReminderTick } from "./engine.js";
import { liftExpiredSuspensions } from "../lib/suspension.js";
import { logTechnical, purgeTechnicalLogs } from "../lib/technicalLog.js";
import { sendNotificationEmail } from "../lib/mailer.js";

// ── Un passage du worker (chaque minute) ─────────────────────────────────────
// 1. Levée des suspensions échues (UC-52) — avant les rappels, pour qu'un
//    compte qui retrouve l'accès les reçoive dès ce passage ;
// 2. Moteur de rappels et de notifications (engine.js) ;
// 3. Purge des journaux techniques de plus de 90 jours (UC-53).
// Chaque passage laisse une entrée au journal technique (catégorie worker) :
// durée, nombre de rappels créés, erreurs — c'est aussi le « battement » que
// l'accueil du support affiche.
export async function runWorkerCycle({ now = new Date(), sendMail = sendNotificationEmail } = {}) {
  const start = Date.now();
  let errors = 0;
  let lifted = 0;
  let purged = 0;
  const failed = async (message, error) => {
    errors += 1;
    if (!process.env.VITEST) console.error(`${message} :`, error);
    await logTechnical({ level: "error", category: "worker", message, metadata: { errorName: error?.name } });
  };

  try {
    lifted = await liftExpiredSuspensions(now);
  } catch (error) {
    await failed("Erreur à la levée des suspensions échues", error);
  }
  try {
    await runReminderTick({ now, sendMail });
  } catch (error) {
    await failed("Erreur du moteur de rappels", error);
  }
  try {
    purged = await purgeTechnicalLogs(now);
  } catch (error) {
    await failed("Erreur à la purge des journaux techniques", error);
  }

  // Rappels créés pendant ce passage (même horodatage `now`).
  const [created] = await db.select({ n: count() }).from(notifications).where(eq(notifications.createdAt, now));
  await logTechnical({
    level: errors > 0 ? "warn" : "info",
    category: "worker",
    message: "Passage du worker terminé",
    metadata: { durationMs: Date.now() - start, reminders: created?.n ?? 0, errors, lifted, purged },
  });
  return { errors, lifted, purged, reminders: created?.n ?? 0 };
}
