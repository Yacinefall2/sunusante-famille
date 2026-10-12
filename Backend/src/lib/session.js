import crypto from "node:crypto";
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from "./jwt.js";

// Cookies de session (jetons d'accès et de rafraîchissement), communs aux
// routes d'authentification et de gestion du compte. SameSite=Strict : jamais
// envoyés par une requête venue d'un autre site, même voisin.
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

export function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie("access_token", accessToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "strict",
    maxAge: ACCESS_TOKEN_TTL_MS,
    path: "/",
  });
  res.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "strict",
    maxAge: REFRESH_TOKEN_TTL_MS,
    // Le refresh token n'est envoyé que vers les routes d'authentification
    path: "/api/auth",
  });
}

export function clearAuthCookies(res) {
  res.clearCookie("access_token", { path: "/" });
  res.clearCookie("refresh_token", { path: "/api/auth" });
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
