import fs from "node:fs/promises";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { UPLOAD_DIR_PATH } from "../middleware/upload.js";

// Fichiers téléversés des documents de ces fiches. À relever AVANT de
// supprimer les fiches (la suppression en cascade efface les lignes, pas les
// fichiers), puis à effacer une fois la suppression faite.
export async function documentFilesOf(memberIds) {
  if (memberIds.length === 0) return [];
  const rows = await db.select({ fileUrl: documents.fileUrl }).from(documents).where(inArray(documents.memberId, memberIds));
  return rows.filter((r) => r.fileUrl).map((r) => path.join(UPLOAD_DIR_PATH, path.basename(r.fileUrl)));
}

// Efface les fichiers du disque ; silencieux si l'un n'existe déjà plus.
export async function removeFiles(filePaths) {
  await Promise.all(filePaths.map((p) => fs.unlink(p).catch(() => {})));
}
