// Génère les icônes de l'application installable dans public/icons/ :
//   node pwa/generate-icons.js   (ou : npm run icons)
// Sans aucune dépendance : le logo (cœur blanc sur carré dégradé
// turquoise → bleu, comme dans la barre latérale) est dessiné pixel par pixel
// puis encodé en PNG avec zlib. Les fichiers produits sont versionnés : ce
// script ne sert qu'à les refaire si le logo change.
//
// Le cœur est l'union d'un carré tourné de 45° et de deux disques posés sur
// ses côtés supérieurs : la même forme sert pour les PNG et pour icon.svg.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

// Couleurs de l'application (Tailwind teal-500 → blue-600, couleur du thème teal-600)
const FROM = [0x14, 0xb8, 0xa6];
const TO = [0x25, 0x63, 0xeb];

// ── Géométrie du cœur (coordonnées relatives, centrées sur 0) ───────────────
// a : côté du carré. Largeur totale du cœur = a (1 + 1/√2).
const R2 = Math.SQRT2;
function heartAt(widthRatio) {
  const a = widthRatio / (1 + 1 / R2);
  const half = a / R2; // demi-diagonale du carré
  const r = a / 2;
  const c = a / (2 * R2);
  const top = -(c + r);
  const bottom = half;
  const dy = -(top + bottom) / 2; // recentre verticalement
  return { half, r, c, dy };
}

function insideHeart(x, y, h) {
  const yy = y - h.dy;
  if (Math.abs(x) + Math.abs(yy) <= h.half) return true;
  const d1 = (x + h.c) ** 2 + (yy + h.c) ** 2;
  const d2 = (x - h.c) ** 2 + (yy + h.c) ** 2;
  return d1 <= h.r * h.r || d2 <= h.r * h.r;
}

// Carré arrondi de rayon relatif `radius` (0 = plein cadre).
function insideRoundedSquare(x, y, radius) {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax > 0.5 || ay > 0.5) return false;
  const inner = 0.5 - radius;
  if (ax <= inner || ay <= inner) return true;
  return (ax - inner) ** 2 + (ay - inner) ** 2 <= radius * radius;
}

// ── Rendu ───────────────────────────────────────────────────────────────────
// background : "rounded" (icône « any »), "full" (maskable, Apple), "none" (badge)
function render(size, { background, heartWidth, cornerRadius = 0.22 }) {
  const heart = heartAt(heartWidth);
  const SS = 4; // sur-échantillonnage 4×4 : bords lissés
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size - 0.5;
          const y = (py + (sy + 0.5) / SS) / size - 0.5;
          const inBg = background === "full" ? true : background === "rounded" ? insideRoundedSquare(x, y, cornerRadius) : false;
          const inHeart = insideHeart(x, y, heart);
          if (inHeart) fg++;
          else if (inBg) bg++;
        }
      }
      const n = SS * SS;
      // Dégradé diagonal (haut gauche → bas droite)
      const t = (px + py) / (2 * (size - 1));
      const color = FROM.map((c, i) => c + (TO[i] - c) * t);
      const alpha = (fg + bg) / n;
      const o = (py * size + px) * 4;
      if (alpha === 0) continue;
      // Mélange blanc (cœur) et dégradé (fond), pondéré par la couverture
      for (let i = 0; i < 3; i++) pixels[o + i] = Math.round((fg * 255 + bg * color[i]) / (fg + bg));
      pixels[o + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

// ── Encodage PNG (RGBA 8 bits) ──────────────────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 8 bits par canal
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // pas de filtre
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── SVG (icône de l'onglet) : même géométrie ────────────────────────────────
function svgIcon() {
  const S = 512;
  const h = heartAt(0.56);
  const cx = S / 2;
  const cy = S / 2 + h.dy * S;
  const f = (v) => +(v * S).toFixed(2);
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hex(FROM)}"/><stop offset="1" stop-color="${hex(TO)}"/></linearGradient></defs>
  <rect width="${S}" height="${S}" rx="${f(0.22)}" fill="url(#g)"/>
  <g fill="#fff">
    <polygon points="${cx},${cy - f(h.half)} ${cx + f(h.half)},${cy} ${cx},${cy + f(h.half)} ${cx - f(h.half)},${cy}"/>
    <circle cx="${cx - f(h.c)}" cy="${cy - f(h.c)}" r="${f(h.r)}"/>
    <circle cx="${cx + f(h.c)}" cy="${cy - f(h.c)}" r="${f(h.r)}"/>
  </g>
</svg>
`;
}

const ICONS = [
  // Icônes « any » : carré arrondi, cœur bien visible
  { file: "icon-192.png", size: 192, background: "rounded", heartWidth: 0.56 },
  { file: "icon-512.png", size: 512, background: "rounded", heartWidth: 0.56 },
  // Icônes « maskable » : fond plein cadre, cœur dans la zone sûre (cercle de 80 %)
  { file: "maskable-192.png", size: 192, background: "full", heartWidth: 0.44 },
  { file: "maskable-512.png", size: 512, background: "full", heartWidth: 0.44 },
  // iPhone / iPad : fond plein (iOS arrondit lui-même les coins)
  { file: "apple-touch-icon.png", size: 180, background: "full", heartWidth: 0.52 },
  // Petite icône de la barre d'état Android : silhouette blanche sur transparent
  { file: "badge-96.png", size: 96, background: "none", heartWidth: 0.8 },
];

fs.mkdirSync(OUT, { recursive: true });
for (const icon of ICONS) {
  fs.writeFileSync(path.join(OUT, icon.file), encodePng(icon.size, render(icon.size, icon)));
  console.log(`✓ ${icon.file}`);
}
fs.writeFileSync(path.join(OUT, "icon.svg"), svgIcon());
console.log("✓ icon.svg");
