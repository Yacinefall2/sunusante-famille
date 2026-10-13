import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { UPLOAD_DIR_PATH } from "../middleware/upload.js";
import { encryptToFile, isEncryptedFile, plainSha256 } from "./fileEncryption.js";

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

// ── Chiffrement des anciens fichiers (avant le chiffrement au repos) ─────────
// Lancé au démarrage du serveur (app.js), sans interruption de service : un
// fichier en cours de conversion reste lisible (la restitution lit un
// fichier en clair OU chiffré, selon le magic). Pour chaque document dont le
// fichier est encore en clair : copie chiffrée dans un fichier temporaire,
// VÉRIFIÉE (relue, déchiffrée, SHA-256 comparé à l'original), puis
// substituée à l'original d'un seul coup (rename). En cas d'erreur,
// l'original reste intact. Idempotent : un fichier déjà chiffré n'est pas
// touché. Renvoie { encrypted, alreadyEncrypted, missing, errors }.
const TEMP_SUFFIX = ".chiffrement.tmp";

export async function encryptLegacyDocuments() {
  const report = { encrypted: 0, alreadyEncrypted: 0, missing: 0, errors: 0 };
  // Restes d'une conversion interrompue (arrêt du serveur) : jamais référencés.
  const leftovers = (await fs.readdir(UPLOAD_DIR_PATH).catch(() => [])).filter((n) => n.endsWith(TEMP_SUFFIX));
  await removeFiles(leftovers.map((n) => path.join(UPLOAD_DIR_PATH, n)));

  const rows = await db.select({ id: documents.id, fileUrl: documents.fileUrl }).from(documents).where(isNotNull(documents.fileUrl));
  for (const row of rows) {
    const filePath = path.join(UPLOAD_DIR_PATH, path.basename(row.fileUrl));
    try {
      if (await isEncryptedFile(filePath)) {
        report.alreadyEncrypted += 1;
        continue;
      }
    } catch (error) {
      if (error.code === "ENOENT") report.missing += 1;
      else {
        report.errors += 1;
        console.error(`Chiffrement du document ${row.id} impossible :`, error);
      }
      continue;
    }
    const tempPath = `${filePath}.${crypto.randomUUID()}${TEMP_SUFFIX}`;
    try {
      const before = await fs.stat(filePath);
      const { sha256 } = await encryptToFile(createReadStream(filePath), tempPath, { hash: true });
      if ((await plainSha256(tempPath)) !== sha256) throw new Error("copie chiffrée différente de l'original");
      // Original modifié ou supprimé (document effacé) pendant la conversion : on n'y touche pas.
      const after = await fs.stat(filePath);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("fichier modifié pendant la conversion");
      await fs.rename(tempPath, filePath);
      report.encrypted += 1;
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      report.errors += 1;
      console.error(`Chiffrement du document ${row.id} impossible (original conservé en clair) :`, error);
    }
  }
  return report;
}
