import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    await db.execute(sql`SELECT 1`);
    res.json({ status: "ok", db: "connected" });
  } catch {
    res.status(500).json({ status: "error", db: "disconnected" });
  }
});

export default router;
