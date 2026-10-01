import jwt from "jsonwebtoken";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  throw new Error("JWT_ACCESS_SECRET et JWT_REFRESH_SECRET sont requis (voir .env.example)");
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
  return jwt.sign({ sub: user.id }, REFRESH_SECRET, {
    expiresIn: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET);
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET);
}