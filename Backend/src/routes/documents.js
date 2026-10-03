import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { upload, UPLOAD_DIR_PATH } from "../middleware/upload.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { familyIdForListQuery, familyIdFromMemberId, familyIdFromResource } from "../lib/familyResolvers.js";
import {
  canDeleteDocumentFor,
  canSeeDocument,
  canSetConfidential,
  canWriteMember,
  presentDocuments,
  readableScope,
} from "../lib/documentAccess.js";

const router = Router();

router.get("/", requireFamilyMembership(familyIdForListQuery), async (req, res) => {
  try {
    // Seules les fiches dont le dossier est lisible par ce compte (voir
    // lib/documentAccess.js) ; ?memberId= sur une fiche non lisible → 403.
    const memberIds = await readableScope(req);
    if (!memberIds) return res.status(403).json({ error: "Accès refusé à ce dossier" });
    if (memberIds.length === 0) return res.json([]);
    const all = await db.select().from(documents).where(inArray(documents.memberId, memberIds)).orderBy(documents.uploadedAt);
    // Documents confidentiels retirés pour qui ne doit pas les voir (§10).
    res.json(await presentDocuments(req, all));
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
      const { id, title, documentType, description, isConfidential } = req.body;
      if (!id) return res.status(400).json({ error: "ID manquant" });
      if (!title?.trim() || !documentType) {
        return res.status(400).json({ error: "Données manquantes" });
      }

      const [existing] = await db.select().from(documents).where(eq(documents.id, parseInt(id)));
      if (!existing || !canSeeDocument(req, existing)) return res.status(404).json({ error: "Document introuvable" });
      if (!(await canWriteMember(req, existing.memberId))) {
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }
      const confidentialChange = typeof isConfidential === "boolean" && isConfidential !== existing.isConfidential;
      if (confidentialChange && !canSetConfidential(req, existing.memberId)) {
        return res.status(403).json({ error: "Seul le titulaire du dossier peut marquer un document confidentiel" });
      }

      const [updatedDoc] = await db
        .update(documents)
        .set({
          title: title.trim(),
          documentType,
          description: description || null,
          ...(confidentialChange ? { isConfidential } : {}),
        })
        .where(eq(documents.id, parseInt(id)))
        .returning();
      res.json((await presentDocuments(req, [updatedDoc]))[0] ?? updatedDoc);
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
      // Champ multipart : "true" / "false" en texte.
      const isConfidential = req.body.isConfidential === "true" || req.body.isConfidential === true;

      if (!memberId || !title?.trim() || !documentType) {
        // Si un fichier a été uploadé mais que la validation échoue, on le supprime
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "Données manquantes" });
      }

      if (!(await canWriteMember(req, parseInt(memberId)))) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }
      if (isConfidential && !canSetConfidential(req, memberId)) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: "Seul le titulaire du dossier peut marquer un document confidentiel" });
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
          uploadedByUserId: req.user.id,
          isConfidential,
        })
        .returning();
      res.status(201).json((await presentDocuments(req, [created]))[0]);
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

// Suppression — l'auteur du document ou le titulaire du dossier (UC-15),
// voir canDeleteDocumentFor dans lib/documentAccess.js.
router.delete(
  "/",
  requireFamilyMembership((req) => familyIdFromResource(documents, req.query.id)),
  async (req, res) => {
    try {
      const id = parseInt(req.query.id ?? "");
      if (isNaN(id)) return res.status(400).json({ error: "ID invalide" });

      const [doc] = await db.select().from(documents).where(eq(documents.id, id));
      if (!doc || !canSeeDocument(req, doc)) return res.status(404).json({ error: "Document introuvable" });
      if (!(await canDeleteDocumentFor(req, doc))) {
        return res.status(403).json({
          error: "Seul l'auteur du document ou le titulaire du dossier peut le supprimer",
        });
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