import "dotenv/config";
import fs from "node:fs";
import { pool } from "./src/db/index.js";
import { runReminderTick } from "./src/reminders/engine.js";

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

let running = false;
async function tick() {
  if (running) return; // jamais deux passages simultanés
  running = true;
  try {
    await runReminderTick();
  } catch (error) {
    console.error("Erreur du moteur de rappels :", error);
  } finally {
    running = false;
    fs.writeFileSync(HEARTBEAT, String(Date.now()));
  }
}

await tick();
setInterval(tick, INTERVAL_MS);
