import { Router } from "express";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { documents, members } from "../db/schema.js";
import { uploadSingle, UPLOAD_DIR_PATH } from "../middleware/upload.js";
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
import { tooLong } from "../lib/validation.js";

const router = Router();

// ── Téléversement : contrôle d'accès avant écriture et quota par famille ────

// Espace de stockage maximal des fichiers d'une famille (tous dossiers
// confondus) : un compte ne peut pas remplir le disque du serveur.
export const FAMILY_STORAGE_QUOTA_BYTES = 500 * 1024 * 1024; // 500 Mo
const QUOTA_MESSAGE = "Espace de stockage de la famille plein (500 Mo) : supprimez des documents avant d'en ajouter.";

// Taille totale des fichiers des documents d'une famille, mesurée sur le
// disque (la base ne conserve pas la taille des fichiers).
export async function familyStorageBytes(familyId) {
  const rows = await db
    .select({ fileUrl: documents.fileUrl })
    .from(documents)
    .innerJoin(members, eq(members.id, documents.memberId))
    .where(and(eq(members.familyId, familyId), isNotNull(documents.fileUrl)));
  const sizes = await Promise.all(
    rows.map((r) =>
      fs.promises
        .stat(path.join(UPLOAD_DIR_PATH, path.basename(r.fileUrl)))
        .then((st) => st.size)
        .catch(() => 0)
    )
  );
  return sizes.reduce((a, b) => a + b, 0);
}

const membershipForUpload = requireFamilyMembership((req) => familyIdFromMemberId(req.body.memberId));

// Exécute un middleware hors de la chaîne Express : renvoie sa réponse de
// refus ({ status, error }) ou null s'il laisse passer.
function runCheck(middleware, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, error: body?.error ?? "Accès refusé" });
        return this;
      },
    };
    Promise.resolve(middleware(req, res, () => resolve(null))).catch(reject);
  });
}

// Appelé par Multer quand le fichier arrive, AVANT de l'écrire : le
// frontend (pages/Documents.jsx) envoie memberId avant le fichier, on peut
// donc refuser un compte sans droit d'écriture ou une famille au quota
// atteint sans que rien ne touche le disque. Si memberId arrive après le
// fichier (autre client), les mêmes contrôles sont faits dans la route, et
// le fichier écrit est effacé en cas de refus.
async function authorizeUpload(req) {
  if (!req.body?.memberId) return null;
  const refusal = await runCheck(membershipForUpload, req);
  if (refusal) return refusal;
  if (!(await canWriteMember(req, parseInt(req.body.memberId)))) {
    return { status: 403, error: "Vous n'avez pas les droits d'écriture sur ce dossier" };
  }
  if ((await familyStorageBytes(req.familyId)) >= FAMILY_STORAGE_QUOTA_BYTES) return { status: 413, error: QUOTA_MESSAGE };
  return null;
}

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
      const lengthError = tooLong([
        [title, 255, "Titre"],
        [documentType, 100, "Type de document"],
      ]);
      if (lengthError) {
        return res.status(400).json({ error: lengthError });
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
// IMPORTANT : uploadSingle("file") doit s'exécuter AVANT requireFamilyMembership,
// car req.body.memberId n'existe qu'une fois le corps multipart parsé par Multer.
// L'accès et le quota sont toutefois vérifiés dès l'arrivée du fichier, avant
// son écriture (authorizeUpload ci-dessus), puis de nouveau ici.
router.post(
  "/",
  uploadSingle("file", { authorize: authorizeUpload }),
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

      const lengthError = tooLong([
        [title, 255, "Titre"],
        [documentType, 100, "Type de document"],
      ]);
      if (lengthError) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: lengthError });
      }

      if (!(await canWriteMember(req, parseInt(memberId)))) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: "Vous n'avez pas les droits d'écriture sur ce dossier" });
      }
      if (isConfidential && !canSetConfidential(req, memberId)) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: "Seul le titulaire du dossier peut marquer un document confidentiel" });
      }
      // Quota de la famille, nouveau fichier compris (il n'est pas encore en base).
      if (req.file && (await familyStorageBytes(req.familyId)) + req.file.size > FAMILY_STORAGE_QUOTA_BYTES) {
        fs.unlink(req.file.path, () => {});
        return res.status(413).json({ error: QUOTA_MESSAGE });
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