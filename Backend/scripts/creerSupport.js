#!/usr/bin/env node
// ── Comptes support (acteur A5) : création, désactivation, double facteur ────
// Seul moyen de créer un compte support : aucune route de l'API ne le permet.
//
//   npm run support:creer -- --email support@exemple.sn --nom "Awa Ndiaye"
//   npm run support:desactiver -- --email support@exemple.sn
//   npm run support:reinitialiser-2fa -- --email support@exemple.sn
//
// Dans Docker (image de production, mêmes variables que le serveur) :
//   docker compose exec backend npm run support:creer -- --email support@exemple.sn --nom "Awa Ndiaye"
//
// Le mot de passe est généré (24 caractères aléatoires) et affiché UNE SEULE
// FOIS, avec le QR code du double facteur à scanner dans une application
// d'authentification (Google Authenticator, Microsoft Authenticator, Aegis…).
import "dotenv/config";
import QRCode from "qrcode";
import { pool } from "../src/db/index.js";
import { createSupportUser, deactivateSupportUser, resetSupportTotp } from "../src/lib/supportAccounts.js";

const COMMANDS = ["creer", "desactiver", "reinitialiser-2fa"];

// --email x --nom "Y" (ou --email=x)
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

async function printTotp({ secret, otpauthUrl }) {
  console.log("\nDouble facteur — scannez ce QR code dans votre application d'authentification :\n");
  console.log(await QRCode.toString(otpauthUrl, { type: "terminal", small: true }));
  console.log("Ou saisissez la clé à la main :", secret);
  console.log("Adresse otpauth :", otpauthUrl);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  // Sous PowerShell, « -- » est absorbé : npm prend alors --email et --nom
  // pour ses propres options et ne transmet que les valeurs, sans leur nom.
  // On les retrouve : l'adresse est la valeur qui contient « @ », le nom le reste.
  if (typeof args.email !== "string" || !args.email.includes("@")) {
    const positional = rest.filter((a) => !a.startsWith("--"));
    const email = positional.find((a) => a.includes("@"));
    if (email) {
      args.email = email;
      if (typeof args.nom !== "string") args.nom = positional.filter((a) => a !== email).join(" ");
    }
  }
  if (!COMMANDS.includes(command) || typeof args.email !== "string") {
    console.error(
      "Usage :\n" +
        '  npm run support:creer -- --email <adresse> --nom "<Prénom Nom>"\n' +
        "  npm run support:desactiver -- --email <adresse>\n" +
        "  npm run support:reinitialiser-2fa -- --email <adresse>"
    );
    process.exitCode = 1;
    return;
  }

  if (command === "creer") {
    const result = await createSupportUser({ email: args.email, name: typeof args.nom === "string" ? args.nom : "" });
    console.log(`✅ Compte support créé : ${result.user.name} <${result.user.email}>`);
    console.log("\nMot de passe (affiché une seule fois, à transmettre par un canal sûr) :");
    console.log(`  ${result.password}`);
    await printTotp(result);
    console.log("\nConnexion : /admin (adresse + mot de passe + code à 6 chiffres).");
  } else if (command === "desactiver") {
    const user = await deactivateSupportUser(args.email);
    console.log(`✅ Compte support désactivé : ${user.email} (sessions fermées)`);
  } else {
    const result = await resetSupportTotp(args.email);
    console.log(`✅ Double facteur réinitialisé pour ${result.user.email} (l'ancien code ne fonctionne plus, sessions fermées)`);
    await printTotp(result);
  }
}

main()
  .catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
