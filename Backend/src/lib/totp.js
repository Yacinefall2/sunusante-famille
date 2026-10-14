import crypto from "node:crypto";

// ── Double facteur du support : codes TOTP (RFC 6238, HMAC-SHA1, 6 chiffres,
// pas de 30 secondes) — compatibles avec toute application d'authentification
// (Google Authenticator, Microsoft Authenticator, FreeOTP, Aegis…).
// Implémentation avec le module crypto natif : aucune dépendance.

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
// Tolérance d'horloge : le pas précédent et le suivant sont acceptés.
export const TOTP_WINDOW = 1;
export const TOTP_ISSUER = "SunuSanté Famille Support";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// Nouveau secret : 20 octets aléatoires (160 bits, taille recommandée par la RFC 4226).
export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

export const stepAt = (time = Date.now()) => Math.floor(time / 1000 / TOTP_STEP_SECONDS);

// Code HOTP (RFC 4226) pour un compteur donné.
export function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(binary).padStart(TOTP_DIGITS, "0");
}

export const totpCode = (secret, time = Date.now()) => hotp(secret, stepAt(time));

// Vérifie un code. Renvoie le pas de temps reconnu (à mémoriser : un code ne
// sert qu'une fois), ou null. Un pas inférieur ou égal à `lastStep` (déjà
// utilisé) est refusé, même s'il est dans la fenêtre.
export function verifyTotp(secret, code, { lastStep = null, time = Date.now() } = {}) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return null;
  const expected = Buffer.from(code.trim());
  const current = stepAt(time);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const step = current + delta;
    if (lastStep !== null && lastStep !== undefined && step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, step)), expected)) return step;
  }
  return null;
}

// Adresse otpauth:// à scanner (QR code) dans l'application d'authentification.
export function otpauthUrl(secret, email) {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Chiffrement du secret au repos (AES-256-GCM) ─────────────────────────────
// Clé dérivée (HKDF-SHA256) de SUPPORT_TOTP_KEY si elle est définie, sinon de
// JWT_ACCESS_SECRET — même approche que le jeton de fiche d'urgence
// (lib/sharing.js). Une copie de la base seule ne suffit donc pas à produire
// des codes. Changer ce secret oblige à réinitialiser le double facteur des
// comptes support (npm run support:reinitialiser-2fa).
const FORMAT = "v1";
let cachedKey = null;
function totpKey() {
  const secret = process.env.SUPPORT_TOTP_KEY || process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("SUPPORT_TOTP_KEY ou JWT_ACCESS_SECRET est requis pour chiffrer les secrets du double facteur");
  if (cachedKey?.secret !== secret) {
    cachedKey = { secret, key: Buffer.from(crypto.hkdfSync("sha256", secret, "sunusante-famille", "secret-totp-support-v1", 32)) };
  }
  return cachedKey.key;
}

// Le compte (adresse) est lié au chiffré : recopié sur un autre compte, il ne
// se déchiffre pas.
const aadFor = (email) => Buffer.from(`support_user:${String(email).toLowerCase()}`);

export function encryptTotpSecret(secret, email) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", totpKey(), iv);
  cipher.setAAD(aadFor(email));
  const encrypted = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  return `${FORMAT}:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
}

export function decryptTotpSecret(value, email) {
  if (typeof value !== "string" || !value.startsWith(`${FORMAT}:`)) return null;
  try {
    const raw = Buffer.from(value.slice(FORMAT.length + 1), "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", totpKey(), raw.subarray(0, 12));
    decipher.setAAD(aadFor(email));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null; // clé changée ou valeur altérée
  }
}
