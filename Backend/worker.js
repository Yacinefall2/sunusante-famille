import "dotenv/config";
import fs from "node:fs";
import { pool } from "./src/db/index.js";
import { runWorkerCycle } from "./src/reminders/cycle.js";
import { pushConfig } from "./src/lib/push.js";

// Service « worker » : passe toutes les minutes sur le moteur de rappels.
// Un verrou PostgreSQL garantit qu'un seul worker travaille à la fois, même si
// plusieurs conteneurs étaient lancés : les autres restent en attente.
const INTERVAL_MS = 60 * 1000;
const LOCK_ID = 7_240_651; // identifiant arbitraire du verrou consultatif
const HEARTBEAT = "/tmp/worker-heartbeat";

const lockClient = await pool.connect();
async function acquireLock() {
  for (;;) {
    const { rows } = await lockClient.query("select pg_try_advisory_lock($1) as ok", [LOCK_ID]);
    if (rows[0].ok) return;
    fs.writeFileSync(HEARTBEAT, String(Date.now())); // en attente, mais vivant
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

await acquireLock();
console.log("✅ Worker de rappels SunuSanté Famille démarré");
// Notifications push : avertit si les clés VAPID manquent (push désactivé).
if (pushConfig()) console.log("🔔 Notifications push activées");

let running = false;
async function tick() {
  if (running) return; // jamais deux passages simultanés
  running = true;
  try {
    // Rappels, levée des suspensions échues, purge des journaux techniques
    // (90 jours) ; chaque passage est noté au journal technique (UC-53).
    await runWorkerCycle();
  } catch (error) {
    console.error("Erreur du moteur de rappels :", error);
  } finally {
    running = false;
    fs.writeFileSync(HEARTBEAT, String(Date.now()));
  }
}

await tick();
setInterval(tick, INTERVAL_MS);
