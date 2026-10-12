import { Router } from "express";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { sendStoredFile } from "../middleware/upload.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdFromMemberId } from "../lib/familyResolvers.js";
import { canReadMember, canSeeDocument } from "../lib/documentAccess.js";

// Fichiers téléversés (ordonnances, résultats, imagerie). Servis uniquement à
// un compte qui peut lire le dossier auquel le document appartient — même
// règle que la liste des documents, et non plus à tout compte connecté.
const router = Router();

async function findDocument(req) {
  const filename = path.basename(req.params.filename);
  const [doc] = await db.select().from(documents).where(eq(documents.fileUrl, `/uploads/${filename}`));
  req.document = doc ?? null;
  return doc;
}

router.get(
  "/:filename",
  async (req, res, next) => {
    try {
      if (!(await findDocument(req))) return res.status(404).json({ error: "Fichier introuvable" });
      next();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  },
  requireFamilyMembership((req) => familyIdFromMemberId(req.document.memberId)),
  async (req, res) => {
    try {
      if (!(await canReadMember(req, req.document.memberId)) || !canSeeDocument(req, req.document)) {
        return res.status(403).json({ error: "Accès refusé à ce dossier" });
      }
      sendStoredFile(res, req.document.fileUrl, req.document.originalName);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;
