import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

// Créer le dossier uploads s'il n'existe pas encore
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Types de fichiers autorisés pour des documents médicaux. L'extension
// enregistrée vient de cette table, jamais du nom envoyé par le navigateur :
// un « .html » ou « .svg » déguisé ne peut pas être stocké comme tel.
const ALLOWED_TYPES = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
};

// Signature binaire attendue en tête de fichier pour chaque extension : le
// type déclaré par le navigateur ne suffit pas, il est choisi par l'expéditeur.
const startsWith = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const SIGNATURES = {
  ".pdf": (b) => startsWith(b, ascii("%PDF")),
  ".jpg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  ".png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]),
  ".webp": (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
  ".heic": (b) => startsWith(b, ascii("ftyp"), 4),
  ".doc": (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0]),
  ".docx": (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${ALLOWED_TYPES[file.mimetype]}`),
});

function fileFilter(req, file, cb) {
  if (ALLOWED_TYPES[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error("Type de fichier non autorisé (PDF, image ou document Word uniquement)"));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 Mo max par fichier
});

function matchesSignature(file) {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file.path, "r");
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  return SIGNATURES[path.extname(file.filename)]?.(head) ?? false;
}

// Téléversement d'un fichier (champ `field`) : erreurs renvoyées en JSON,
// contenu vérifié, et fichier effacé si la requête n'aboutit pas (refus
// d'accès, données manquantes...) pour ne pas laisser d'orphelins sur le disque.
export function uploadSingle(field) {
  const handler = upload.single(field);
  return (req, res, next) => {
    res.on("finish", () => {
      if (req.file && res.statusCode >= 300) fs.unlink(req.file.path, () => {});
    });
    handler(req, res, (err) => {
      if (err) {
        const message =
          err.code === "LIMIT_FILE_SIZE" ? "Le fichier dépasse la taille maximale de 15 Mo" : err.message || "Fichier refusé";
        return res.status(400).json({ error: message });
      }
      if (req.file && !matchesSignature(req.file)) {
        return res.status(400).json({ error: "Le contenu du fichier ne correspond pas à son type (PDF, image ou document Word)" });
      }
      next();
    });
  };
}

// Types servis en ligne (aperçu dans le navigateur) ; tout le reste est
// proposé au téléchargement.
const INLINE_TYPES = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const DOWNLOAD_TYPES = {
  ".heic": "image/heic",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// Envoie un fichier téléversé avec un type imposé par le serveur (jamais
// deviné) : un ancien fichier à l'extension inattendue part en
// téléchargement brut et ne peut pas s'exécuter dans la page.
export function sendStoredFile(res, fileUrl, downloadName) {
  const filename = path.basename(fileUrl);
  const ext = path.extname(filename).toLowerCase();
  const inline = INLINE_TYPES[ext];
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "private, no-store");
  if (inline) {
    res.type(inline);
    if (ext === ".pdf") {
      // Visionneuse PDF du navigateur, y compris dans l'aperçu (iframe) de la
      // page Documents : pas de CSP restrictive, cadre autorisé sur le site.
      res.removeHeader("Content-Security-Policy");
      res.set("X-Frame-Options", "SAMEORIGIN");
    } else {
      // Les images n'ont rien à exécuter.
      res.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    }
  } else {
    // attachment() déduit un type du nom (choisi par l'utilisateur) : on
    // impose le nôtre ensuite.
    res.attachment(downloadName || filename);
    res.type(DOWNLOAD_TYPES[ext] ?? "application/octet-stream");
  }
  res.sendFile(path.join(UPLOAD_DIR, filename), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Fichier introuvable" });
  });
}

export const UPLOAD_DIR_PATH = UPLOAD_DIR;
