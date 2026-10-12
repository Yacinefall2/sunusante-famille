import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  throw new Error("JWT_ACCESS_SECRET et JWT_REFRESH_SECRET sont requis (voir .env.example)");
}

// Secrets trop faibles : quiconque les devine peut fabriquer une session
// valide pour n'importe quel compte. En production (NODE_ENV=production), le
// serveur refuse de démarrer ; en développement et en test, simple
// avertissement (les tests utilisent des secrets courts).
export const MIN_SECRET_LENGTH = 32;

export function weakSecretProblems(access = ACCESS_SECRET, refresh = REFRESH_SECRET) {
  const problems = [];
  for (const [name, value] of [
    ["JWT_ACCESS_SECRET", access],
    ["JWT_REFRESH_SECRET", refresh],
  ]) {
    if (value.length < MIN_SECRET_LENGTH) problems.push(`${name} fait moins de ${MIN_SECRET_LENGTH} caractères`);
    if (/changeme/i.test(value)) problems.push(`${name} contient encore « changeme » (valeur d'exemple)`);
  }
  if (access === refresh) problems.push("JWT_ACCESS_SECRET et JWT_REFRESH_SECRET sont identiques");
  return problems;
}

{
  const problems = weakSecretProblems();
  if (problems.length > 0) {
    const message = `Secrets JWT trop faibles : ${problems.join(" ; ")}. Générez-en avec : node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`;
    if (process.env.NODE_ENV === "production") throw new Error(message);
    if (!process.env.VITEST) console.warn(`⚠️  ${message}`);
  }
}

// Durées de vie validées avec l'utilisateur :
// access token court (15 min) pour limiter la fenêtre d'exploitation en cas de vol,
// refresh token long (30 jours) pour garder la session active sans reconnexion manuelle.
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, ACCESS_SECRET, {
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  });
}

export function signRefreshToken(user) {
  // jti aléatoire : deux sessions ouvertes dans la même seconde ont des
  // jetons distincts (sinon identiques, donc révoqués ensemble).
  return jwt.sign({ sub: user.id, jti: crypto.randomUUID() }, REFRESH_SECRET, {
    expiresIn: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET, { algorithms: ["HS256"] });
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET, { algorithms: ["HS256"] });
}