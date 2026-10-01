import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { documents, members } from "../db/schema.js";
import { upload, UPLOAD_DIR_PATH } from "../middleware/upload.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdFromMemberId, familyIdFromResource } from "../lib/familyResolvers.js";
import { canWriteDocument } from "../lib/documentAccess.js";

const router = Router();

async function resolveForGet(req) {
  if (req.query.familyId) return parseInt(req.query.familyId) || null;
  if (req.query.memberId) return familyIdFromMemberId(req.query.memberId);
  return null;
}

router.get("/", requireFamilyMembership(resolveForGet), async (req, res) => {
  try {
    // Un Dépendant ne voit que les documents de sa propre fiche liée.
    if (req.membership.role === "dependent") {
      if (!req.membership.linkedMemberId) return res.json([]);
      const own = await db
        .select()
        .from(documents)
        .where(eq(documents.memberId, req.membership.linkedMemberId))
        .orderBy(documents.uploadedAt);
      return res.json(own);
    }

    const { memberId, familyId } = req.query;

    if (memberId) {
      const all = await db.select().from(documents).where(eq(documents.memberId, parseInt(memberId))).orderBy(documents.uploadedAt);
      return res.json(all);
    }

    const familyMembers = await db.select({ id: members.id }).from(members).where(eq(members.familyId, parseInt(familyId)));
    if (familyMembers.length === 0) return res.json([]);
    const memberIds = familyMembers.map((m) => m.id);
    const all = await db.select().from(documents).where(inArray(documents.memberId, memberIds)).orderBy(documents.uploadedAt);
    res.json(all);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Modification d'un document (champs uniquement, fichier inchangé)
router.put(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(documents, req.body.id)),
  async (req, res) => {
    try {
      const { id, title, documentType, description } = req.body;
      if (!id) return res.status(400).json({ error: "ID manquant" });
      if (!title?.trim() || !documentType) {
        return res.status(400).json({ error: "Données manquantes" });
      }

      const [existing] = await db.select({ memberId: documents.memberId }).from(documents).where(eq(documents.id, parseInt(id)));
      if (!existing) return res.status(404).json({ error: "Document introuvable" });
      if (!(await canWriteDocument(existing.memberId, req.user.id, req.membership))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      const [updatedDoc] = await db
        .update(documents)
        .set({
          title: title.trim(),
          documentType,
          description: description || null,
        })
        .where(eq(documents.id, parseInt(id)))
        .returning();
      res.json(updatedDoc);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Upload réel d'un fichier (multipart/form-data, champ "file")
// IMPORTANT : upload.single("file") doit s'exécuter AVANT requireFamilyMembership,
// car req.body.memberId n'existe qu'une fois le corps multipart parsé par Multer.
router.post(
  "/",
  upload.single("file"),
  requireFamilyMembership((req) => familyIdFromMemberId(req.body.memberId)),
  async (req, res) => {
    try {
      const { memberId, title, documentType, description } = req.body;

      if (!memberId || !title?.trim() || !documentType) {
        // Si un fichier a été uploadé mais que la validation échoue, on le supprime
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "Données manquantes" });
      }

      if (!(await canWriteDocument(parseInt(memberId), req.user.id, req.membership))) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      const fileUrl = req.file ? `/uploads/${req.file.filename}` : null;
      const originalName = req.file ? req.file.originalname : null;

      const [created] = await db
        .insert(documents)
        .values({
          memberId: parseInt(memberId),
          title: title.trim(),
          documentType,
          description: description || null,
          fileUrl,
          originalName,
        })
        .returning();
      res.status(201).json(created);
    } catch (error) {
      console.error(error);
      if (req.file) fs.unlink(req.file.path, () => {});
      if (error.message?.includes("Type de fichier non autorisé")) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// Suppression — Titulaire, Gestionnaire de ce dossier, ou Parent (Admin).
router.delete(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(documents, req.query.id)),
  async (req, res) => {
    try {
      const id = parseInt(req.query.id ?? "");
      if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });

      const [doc] = await db.select().from(documents).where(eq(documents.id, id));
      if (!doc) return res.status(404).json({ error: "Document introuvable" });
      if (!(await canWriteDocument(doc.memberId, req.user.id, req.membership))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }

      await db.delete(documents).where(eq(documents.id, id));

      // Supprimer aussi le fichier physique du disque s'il existe
      if (doc?.fileUrl) {
        const filename = path.basename(doc.fileUrl);
        const filePath = path.join(UPLOAD_DIR_PATH, filename);
        fs.unlink(filePath, () => {}); // silencieux si le fichier n'existe déjà plus
      }

      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

export default router;