import crypto from "node:crypto";
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from "./jwt.js";

// Cookies de session (jetons d'accès et de rafraîchissement), communs aux
// routes d'authentification et de gestion du compte. SameSite=Strict : jamais
// envoyés par une requête venue d'un autre site, même voisin.
export const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

// En production, les cookies de session doivent voyager uniquement en HTTPS
// (attribut Secure) : sinon un réseau Wi-Fi public suffit à voler une session
// et donc l'accès à des dossiers médicaux. Le serveur refuse de démarrer.
// En local sur http://localhost, COOKIE_SECURE=true fonctionne aussi : les
// navigateurs considèrent localhost comme une origine sûre.
if (process.env.NODE_ENV === "production" && !COOKIE_SECURE) {
  throw new Error(
    "COOKIE_SECURE doit valoir \"true\" en production (NODE_ENV=production) : servez l'application en HTTPS. " +
      "Pour un essai local en HTTP sur une autre adresse que localhost, définissez NODE_ENV=development."
  );
}

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
