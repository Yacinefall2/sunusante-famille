import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ── Chiffrement des fichiers au repos (UC-57, S2, UC-58) ─────────────────────
// Documents médicaux (uploads/) et archives d'export (uploads/exports/) sont
// écrits chiffrés sur le disque : une copie du volume des fichiers (vol du
// disque, sauvegarde égarée) ne livre aucun contenu sans la clé maîtresse.
//
// Chiffrement d'enveloppe : chaque fichier a sa PROPRE clé de données
// (32 octets aléatoires) qui chiffre son contenu en AES-256-GCM ; cette clé
// est elle-même chiffrée (AES-256-GCM) par la clé maîtresse
// DOCUMENTS_ENCRYPTION_KEY, qui n'est jamais en base ni dans le code.
//
// Format d'un fichier chiffré (auto-descriptif : le fichier et la clé
// maîtresse suffisent pour le relire) — en-tête de 101 octets puis contenu :
//
//   octets  0-3    « SSF1 » (magic : SunuSanté Fichier, format 1)
//   octet   4      version du format (1)
//   octets  5-12   identifiant de la clé maîtresse (empreinte, 8 octets)
//   octets 13-24   IV de l'enveloppe (12 octets)
//   octets 25-56   clé de données chiffrée (32 octets)
//   octets 57-72   tag GCM de l'enveloppe (16 octets)
//   octets 73-84   IV du contenu (12 octets)
//   octets 85-100  tag GCM du contenu (16 octets, écrit en fin de chiffrement)
//   octets 101-…   contenu chiffré (même taille que le contenu en clair)
//
// Données authentifiées : l'enveloppe est liée aux octets 0-12 (magic,
// version, identifiant de clé), le contenu aux octets 0-4 seulement — ainsi
// une rotation de la clé maîtresse n'aura qu'à réécrire l'enveloppe (en-tête),
// sans rechiffrer le contenu.
//
// Un fichier sans le magic est un ancien fichier en clair (avant ce
// chiffrement) : il reste lisible tel quel, le temps d'être converti au
// démarrage du serveur (lib/documentFiles.js encryptLegacyDocuments).

export const MAGIC = Buffer.from("SSF1", "ascii");
const FORMAT_VERSION = 1;
const KEY_ID_LENGTH = 8;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const DATA_KEY_LENGTH = 32;
const KEY_ID_OFFSET = MAGIC.length + 1; // 5
const WRAP_IV_OFFSET = KEY_ID_OFFSET + KEY_ID_LENGTH; // 13
const WRAPPED_KEY_OFFSET = WRAP_IV_OFFSET + IV_LENGTH; // 25
const WRAP_TAG_OFFSET = WRAPPED_KEY_OFFSET + DATA_KEY_LENGTH; // 57
const CONTENT_IV_OFFSET = WRAP_TAG_OFFSET + TAG_LENGTH; // 73
const CONTENT_TAG_OFFSET = CONTENT_IV_OFFSET + IV_LENGTH; // 85
export const HEADER_LENGTH = CONTENT_TAG_OFFSET + TAG_LENGTH; // 101

// ── Clé maîtresse ────────────────────────────────────────────────────────────

const GENERATE_HINT =
  "Générez-la avec : node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"";

// 32 octets, encodés en base64 (44 caractères) ou en hexadécimal (64 caractères).
export function parseMasterKey(value, name = "DOCUMENTS_ENCRYPTION_KEY") {
  const raw = String(value ?? "").trim();
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) key = Buffer.from(raw, "base64");
  if (!key || key.length !== 32) {
    throw new Error(`${name} invalide : 32 octets attendus, encodés en base64 (44 caractères) ou en hexadécimal (64 caractères). ${GENERATE_HINT}`);
  }
  return key;
}

// Empreinte publique d'une clé maîtresse, rangée dans l'en-tête : à la
// lecture, elle désigne la clé à utiliser (actuelle ou précédente).
const keyIdOf = (key) => crypto.createHash("sha256").update("sunusante-famille:cle-documents:").update(key).digest().subarray(0, KEY_ID_LENGTH);

// Clé de secours hors production : dérivée de JWT_ACCESS_SECRET (comme le
// jeton de fiche d'urgence, avec un libellé propre).
const derivedKey = (secret) => Buffer.from(crypto.hkdfSync("sha256", secret, "sunusante-famille", "cle-maitresse-documents-v1", 32));

// Clés maîtresses selon l'environnement : `current` chiffre les nouveaux
// fichiers ; `all` sert à relire (actuelle, DOCUMENTS_ENCRYPTION_KEY_PREVIOUS
// et, hors production, la clé dérivée de JWT_ACCESS_SECRET).
// En production, la clé est obligatoire et doit être valide ; partout, une
// clé fournie mais invalide est une erreur (jamais de repli silencieux).
export function resolveDocumentKeys(env = process.env) {
  const production = env.NODE_ENV === "production";
  const provided = env.DOCUMENTS_ENCRYPTION_KEY?.trim();
  const previous = env.DOCUMENTS_ENCRYPTION_KEY_PREVIOUS?.trim();
  const keys = [];
  let derived = false;
  if (provided) {
    keys.push(parseMasterKey(provided));
  } else if (production) {
    throw new Error(`DOCUMENTS_ENCRYPTION_KEY est requise en production (chiffrement des documents). ${GENERATE_HINT}`);
  } else {
    if (!env.JWT_ACCESS_SECRET) throw new Error("DOCUMENTS_ENCRYPTION_KEY ou JWT_ACCESS_SECRET est requis pour chiffrer les documents");
    keys.push(derivedKey(env.JWT_ACCESS_SECRET));
    derived = true;
  }
  if (previous) keys.push(parseMasterKey(previous, "DOCUMENTS_ENCRYPTION_KEY_PREVIOUS"));
  if (!production && !derived && env.JWT_ACCESS_SECRET) keys.push(derivedKey(env.JWT_ACCESS_SECRET));
  const all = [];
  for (const key of keys) {
    const id = keyIdOf(key);
    if (!all.some((k) => k.id.equals(id))) all.push({ id, key });
  }
  return { current: all[0], all, derived };
}

// Clés en vigueur, recalculées si l'environnement change (tests).
let cached = null;
function documentKeys() {
  const signature = [
    process.env.NODE_ENV,
    process.env.DOCUMENTS_ENCRYPTION_KEY,
    process.env.DOCUMENTS_ENCRYPTION_KEY_PREVIOUS,
    process.env.JWT_ACCESS_SECRET,
  ].join("\u0000");
  if (cached?.signature !== signature) cached = { signature, keys: resolveDocumentKeys(process.env) };
  return cached.keys;
}

// Contrôle au démarrage (serveur et worker), même principe que lib/jwt.js :
// en production, pas de démarrage sans clé valide ; en développement, clé
// dérivée de JWT_ACCESS_SECRET avec un avertissement.
{
  const { derived } = documentKeys();
  if (derived && !process.env.VITEST) {
    console.warn(
      `⚠️  DOCUMENTS_ENCRYPTION_KEY absente : documents chiffrés avec une clé dérivée de JWT_ACCESS_SECRET (développement uniquement). ${GENERATE_HINT}`
    );
  }
}

// ── Erreurs de lecture ───────────────────────────────────────────────────────

// Fichier chiffré illisible : altéré (tag GCM invalide, en-tête abîmé) ou
// chiffré avec une clé maîtresse inconnue. Jamais servi, même partiellement.
export class UnreadableFileError extends Error {
  constructor(message, filePath) {
    super(`${message} : ${filePath}`);
    this.code = "EUNREADABLE";
  }
}

// ── Écriture ─────────────────────────────────────────────────────────────────

// Chiffre en flux `source` (flux lisible, ou [flux, transformations...]) dans
// `destPath`. Rien n'est gardé en mémoire au-delà d'un morceau. Renvoie
// { plainSize, storedSize, sha256 } (sha256 du contenu en clair si
// demandé). En cas d'échec, le fichier partiel est effacé.
export async function encryptToFile(source, destPath, { hash = false, mode = 0o600 } = {}) {
  const { current } = documentKeys();
  const dataKey = crypto.randomBytes(DATA_KEY_LENGTH);
  const header = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(header, 0);
  header[MAGIC.length] = FORMAT_VERSION;
  current.id.copy(header, KEY_ID_OFFSET);

  const wrapIv = crypto.randomBytes(IV_LENGTH);
  const wrap = crypto.createCipheriv("aes-256-gcm", current.key, wrapIv);
  wrap.setAAD(header.subarray(0, WRAP_IV_OFFSET));
  const wrapped = Buffer.concat([wrap.update(dataKey), wrap.final()]);
  wrapIv.copy(header, WRAP_IV_OFFSET);
  wrapped.copy(header, WRAPPED_KEY_OFFSET);
  wrap.getAuthTag().copy(header, WRAP_TAG_OFFSET);

  const contentIv = crypto.randomBytes(IV_LENGTH);
  contentIv.copy(header, CONTENT_IV_OFFSET);
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey, contentIv);
  cipher.setAAD(header.subarray(0, KEY_ID_OFFSET));

  let plainSize = 0;
  const digest = hash ? crypto.createHash("sha256") : null;
  const count = new Transform({
    transform(chunk, encoding, callback) {
      plainSize += chunk.length;
      digest?.update(chunk);
      callback(null, chunk);
    },
  });

  const output = fs.createWriteStream(destPath, { mode });
  try {
    // En-tête d'abord, tag du contenu encore à zéro (connu en fin de flux).
    output.write(header);
    await pipeline(...[source].flat(), count, cipher, output);
    const fh = await fsp.open(destPath, "r+");
    try {
      await fh.write(cipher.getAuthTag(), 0, TAG_LENGTH, CONTENT_TAG_OFFSET);
    } finally {
      await fh.close();
    }
  } catch (error) {
    // Descripteur refermé avant l'effacement (Windows refuse d'effacer un fichier ouvert).
    if (!output.closed) {
      await new Promise((resolve) => {
        output.once("close", resolve);
        output.destroy();
      });
    }
    await fsp.rm(destPath, { force: true });
    throw error;
  }
  return { plainSize, storedSize: plainSize + HEADER_LENGTH, sha256: digest?.digest("hex") ?? null };
}

// ── Lecture ──────────────────────────────────────────────────────────────────

// Fichier stocké ouvert (chiffré ou ancien fichier en clair). Le descripteur
// reste le même du début à la fin : un fichier converti entre-temps
// (remplacé par rename) continue d'être lu dans sa version d'origine.
class StoredFile {
  constructor(handle, filePath, size, envelope) {
    this.handle = handle;
    this.filePath = filePath;
    this.envelope = envelope; // null pour un fichier en clair
    this.encrypted = Boolean(envelope);
    this.size = envelope ? size - HEADER_LENGTH : size; // taille du contenu en clair
  }

  // Contenu en clair, morceau par morceau. Pour un fichier chiffré, le tag
  // GCM n'est vérifié qu'à la fin : une altération lève UnreadableFileError
  // APRÈS les morceaux déjà rendus — d'où verify() avant tout envoi.
  async *chunks() {
    const stream = this.handle.createReadStream({ start: this.envelope ? HEADER_LENGTH : 0, autoClose: false, highWaterMark: 64 * 1024 });
    if (!this.envelope) {
      yield* stream;
      return;
    }
    const { dataKey, contentIv, contentTag, aad } = this.envelope;
    const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey, contentIv);
    decipher.setAAD(aad);
    decipher.setAuthTag(contentTag);
    for await (const chunk of stream) {
      const out = decipher.update(chunk);
      if (out.length) yield out;
    }
    let last;
    try {
      last = decipher.final();
    } catch {
      throw new UnreadableFileError("Fichier chiffré altéré (authentification GCM invalide)", this.filePath);
    }
    if (last.length) yield last;
  }

  // Lecture complète sans rien rendre : vérifie l'authenticité du contenu.
  async verify() {
    if (!this.envelope) return;
    // eslint-disable-next-line no-unused-vars
    for await (const chunk of this.chunks());
  }

  async close() {
    await this.handle.close().catch(() => {});
  }
}

// Déchiffre l'enveloppe d'un en-tête ; lève UnreadableFileError si l'en-tête
// est abîmé ou si aucune clé maîtresse connue ne l'ouvre.
function openEnvelope(header, filePath) {
  if (header.length < HEADER_LENGTH || header[MAGIC.length] !== FORMAT_VERSION) {
    throw new UnreadableFileError("En-tête de fichier chiffré invalide", filePath);
  }
  const keyId = header.subarray(KEY_ID_OFFSET, WRAP_IV_OFFSET);
  const master = documentKeys().all.find((k) => k.id.equals(keyId));
  if (!master) throw new UnreadableFileError("Fichier chiffré avec une clé maîtresse inconnue (DOCUMENTS_ENCRYPTION_KEY changée ?)", filePath);
  let dataKey;
  try {
    const unwrap = crypto.createDecipheriv("aes-256-gcm", master.key, header.subarray(WRAP_IV_OFFSET, WRAPPED_KEY_OFFSET));
    unwrap.setAAD(header.subarray(0, WRAP_IV_OFFSET));
    unwrap.setAuthTag(header.subarray(WRAP_TAG_OFFSET, CONTENT_IV_OFFSET));
    dataKey = Buffer.concat([unwrap.update(header.subarray(WRAPPED_KEY_OFFSET, WRAP_TAG_OFFSET)), unwrap.final()]);
  } catch {
    throw new UnreadableFileError("Enveloppe de fichier chiffré altérée", filePath);
  }
  return {
    keyId: Buffer.from(keyId),
    dataKey,
    contentIv: Buffer.from(header.subarray(CONTENT_IV_OFFSET, CONTENT_TAG_OFFSET)),
    contentTag: Buffer.from(header.subarray(CONTENT_TAG_OFFSET, HEADER_LENGTH)),
    aad: Buffer.from(header.subarray(0, KEY_ID_OFFSET)),
  };
}

const startsWithMagic = (buf, n) => n >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);

// Ouvre un fichier stocké (erreur ENOENT s'il n'existe pas,
// UnreadableFileError si son en-tête chiffré ne s'ouvre pas).
export async function openStoredFile(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(HEADER_LENGTH);
    const { bytesRead } = await handle.read(header, 0, HEADER_LENGTH, 0);
    const envelope = startsWithMagic(header, bytesRead) ? openEnvelope(header.subarray(0, bytesRead), filePath) : null;
    return new StoredFile(handle, filePath, size, envelope);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

// Ouvre ET vérifie un fichier (authenticité du contenu) : à utiliser avant
// d'envoyer quoi que ce soit, pour ne jamais servir un contenu altéré.
export async function openVerifiedFile(filePath) {
  const file = await openStoredFile(filePath);
  try {
    await file.verify();
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

// Le fichier est-il au format chiffré ? (lecture des 4 premiers octets)
export async function isEncryptedFile(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const head = Buffer.alloc(MAGIC.length);
    const { bytesRead } = await handle.read(head, 0, MAGIC.length, 0);
    return startsWithMagic(head, bytesRead);
  } finally {
    await handle.close();
  }
}

// Contenu en clair d'un fichier stocké, sous forme de flux lisible ouvert à
// la première lecture (archive ZIP : les entrées sont lues l'une après
// l'autre, sans garder un descripteur ouvert par document).
export async function* plainContent(filePath) {
  const file = await openStoredFile(filePath);
  try {
    yield* file.chunks();
  } finally {
    await file.close();
  }
}

// Empreinte SHA-256 du contenu en clair (vérification de la conversion).
export async function plainSha256(filePath) {
  const digest = crypto.createHash("sha256");
  await pipeline(plainContent(filePath), new Writable({ write(chunk, encoding, callback) { digest.update(chunk); callback(); } }));
  return digest.digest("hex");
}

// ── Restitution HTTP ─────────────────────────────────────────────────────────

// Envoie le contenu en clair d'un fichier déjà ouvert et vérifié dans la
// réponse (en-têtes posés par l'appelant), avec Content-Length = taille en
// clair. Si la lecture échoue en cours de route (fichier modifié entre la
// vérification et l'envoi), la connexion est coupée : jamais une réponse
// complète au contenu douteux. `onDone` est appelé une fois l'envoi terminé
// ou interrompu ; le fichier est refermé dans tous les cas.
export function pipeStoredFile(res, file, { onDone } = {}) {
  res.set("Content-Length", String(file.size));
  const done = pipeline(file.chunks(), res).catch((error) => {
    // Client parti en cours de route : rien d'anormal à signaler.
    if (error?.code !== "ERR_STREAM_PREMATURE_CLOSE") console.error("Restitution d'un fichier interrompue :", error);
    res.destroy();
  });
  return done.finally(async () => {
    await file.close();
    onDone?.();
  });
}
