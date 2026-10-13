import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Publie le service worker (pwa/service-worker.js) en /sw.js au moment du
// build, avec la liste des fichiers de l'interface à garder hors ligne et un
// numéro de version (empreinte de cette liste et du code du service worker) :
// chaque nouvelle version de l'application change sw.js, que le navigateur
// installe alors à la place de l'ancien.
//
// Aucune dépendance : le service worker est écrit à la main, cette
// extension ne fait qu'y injecter `self.__SUNUSANTE_BUILD__`.
export function serviceWorkerPlugin({ source = "pwa/service-worker.js", publicDir = "public" } = {}) {
  let root = process.cwd();
  return {
    name: "sunusante-service-worker",
    apply: "build",
    // Après les extensions de Vite : index.html est alors dans le bundle.
    enforce: "post",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      // Fichiers produits par Vite (JS, CSS, index.html…)
      const built = Object.keys(bundle).filter((f) => /\.(html|js|css|svg|png|woff2?)$/.test(f));
      // Fichiers du dossier public/ : icônes et manifeste
      const publicFiles = [];
      const walk = (dir, prefix = "") => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
          else if (/\.(png|svg|ico|webmanifest)$/.test(entry.name)) publicFiles.push(rel);
        }
      };
      walk(path.join(root, publicDir));

      // index.html : page servie hors ligne pour toutes les adresses de l'application
      const files = [...new Set(["index.html", ...built, ...publicFiles])]
        .filter((f) => f !== "sw.js")
        .sort()
        .map((f) => `/${f}`);
      const code = fs.readFileSync(path.join(root, source), "utf8");
      const html = bundle["index.html"]?.source ?? "";
      const version = crypto
        .createHash("sha256")
        .update(JSON.stringify(files))
        .update(String(html))
        .update(code)
        .digest("hex")
        .slice(0, 12);
      const build = JSON.stringify({ version, files });

      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `self.__SUNUSANTE_BUILD__ = ${build};\n${code}`,
      });
    },
  };
}
