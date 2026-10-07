import QRCode from "qrcode";
import { calculateAge, formatDateTime } from "./utils";

// Outils communs au partage médecin et à la fiche d'urgence (phase F).

// ---------------------------------------------------------------------------
// Partage médecin

export const SHARE_DURATIONS = [
  { value: "2h", label: "2 heures" },
  { value: "24h", label: "24 heures" },
  { value: "7j", label: "7 jours" },
];

// Libellé et couleur de l'état d'un lien médecin
export function shareStateInfo(share) {
  switch (share.state) {
    case "pending":
      return { label: "En attente d'ouverture", variant: "warning" };
    case "opened":
      return {
        label: share.consumedAt ? `Ouvert le ${formatDateTime(share.consumedAt)}` : "Ouvert",
        variant: "success",
      };
    case "expired":
      return { label: "Expiré", variant: "default" };
    case "revoked":
      return { label: "Révoqué", variant: "danger" };
    default:
      return { label: share.state, variant: "default" };
  }
}

// Éléments partagés par un lien, en clair
export function shareContentsLabel(share) {
  const parts = [];
  if (share.includeEssentials) parts.push("Informations essentielles");
  if (share.includeTreatments) parts.push("Traitements en cours");
  if (share.includeVaccinations) parts.push("Vaccinations");
  const n = share.documentIds?.length ?? 0;
  if (n > 0) parts.push(`${n} document${n > 1 ? "s" : ""}`);
  return parts.join(" · ") || "—";
}

// ---------------------------------------------------------------------------
// Fiche d'urgence

export const EMERGENCY_FIELD_OPTIONS = [
  { key: "showAge", label: "Âge" },
  { key: "showBloodType", label: "Groupe sanguin" },
  { key: "showAllergies", label: "Allergies" },
  { key: "showTreatments", label: "Traitements en cours" },
  { key: "showEmergencyContact", label: "Personne à prévenir" },
  { key: "showDoctor", label: "Médecin traitant" },
];

export const EMPTY_EMERGENCY_FIELDS = Object.fromEntries(EMERGENCY_FIELD_OPTIONS.map((f) => [f.key, false]));

export const EXTRA_INFO_MAX = 300;

// Reproduit côté client la vue publique calculée par le serveur
// (emergencyPublicView) à partir des réglages en cours d'édition — même forme
// que GET /api/public/emergency/:token. Un champ coché mais vide vaut null.
export function buildEmergencyView(member, activeTreatments, { fields, extraInfo }) {
  const view = { firstName: member.firstName, lastName: member.lastName };
  if (fields.showAge) view.age = calculateAge(member.dateOfBirth);
  if (fields.showBloodType) view.bloodType = member.bloodType || null;
  if (fields.showAllergies) view.allergies = member.allergies || null;
  if (fields.showTreatments) {
    view.treatments = (activeTreatments ?? []).map((t) => ({
      disease: t.disease,
      medications: (t.medications ?? []).map((x) => ({ name: x.name, dosage: x.dosage })),
    }));
  }
  if (fields.showEmergencyContact) {
    view.emergencyContact = {
      name: member.emergencyContactName || null,
      relation: member.emergencyContactRelation || null,
      phone: member.emergencyContactPhone || null,
    };
  }
  if (fields.showDoctor) view.doctor = { name: member.doctorName || null, phone: member.doctorPhone || null };
  const extra = (extraInfo ?? "").trim();
  if (extra) view.extraInfo = extra;
  return view;
}

const medsText = (meds) =>
  (meds ?? [])
    .map((x) => [x.name, x.dosage].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");

export const treatmentText = (t) => {
  const meds = medsText(t.medications);
  return meds ? `${t.disease} (${meds})` : t.disease;
};

export const contactText = (c) => {
  if (!c) return null;
  const who = [c.name, c.relation && `(${c.relation})`].filter(Boolean).join(" ");
  const out = [who, c.phone].filter(Boolean).join(" — ");
  return out || null;
};

// Lignes « en clair » d'une vue d'urgence, dans l'ordre d'affichage. Seuls
// les champs présents dans la vue (donc cochés) apparaissent ; `value` vaut
// null pour un champ coché mais non renseigné sur la fiche.
export function emergencyLines(view) {
  if (!view) return [];
  const lines = [];
  if ("age" in view) lines.push({ key: "age", label: "Âge", value: view.age != null ? `${view.age} ans` : null });
  if ("bloodType" in view) lines.push({ key: "bloodType", label: "Groupe sanguin", value: view.bloodType || null, strong: true });
  if ("allergies" in view) lines.push({ key: "allergies", label: "Allergies", value: view.allergies || null, danger: true });
  if ("treatments" in view) {
    const list = (view.treatments ?? []).map(treatmentText).filter(Boolean);
    lines.push({ key: "treatments", label: "Traitements", value: list.length ? list.join(" ; ") : null });
  }
  if ("emergencyContact" in view) lines.push({ key: "emergencyContact", label: "À prévenir", value: contactText(view.emergencyContact) });
  if ("doctor" in view) lines.push({ key: "doctor", label: "Médecin", value: contactText(view.doctor) });
  if (view.extraInfo) lines.push({ key: "extraInfo", label: "Info utile", value: view.extraInfo, danger: true });
  return lines;
}

// ---------------------------------------------------------------------------
// QR codes et images

export function qrDataUrl(text, width = 320) {
  return QRCode.toDataURL(text, { width, margin: 1, errorCorrectionLevel: "M" });
}

// Découpe un texte en lignes tenant dans `maxWidth` (contexte canvas).
function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Image verticale (1080 x 1920) pour l'écran de verrouillage du téléphone :
// infos vitales en clair et QR code de la fiche à jour. Renvoie un Blob PNG.
export async function emergencyLockScreenBlob(view, url) {
  const W = 1080;
  const H = 1920;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const font = (size, weight = "normal") => `${weight} ${size}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

  // Fond
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#111827");
  grad.addColorStop(1, "#1f2937");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Le haut de l'écran (≈ 480 px) reste libre pour l'heure du téléphone.
  let y = 500;
  ctx.fillStyle = "#dc2626";
  ctx.fillRect(0, y, W, 120);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = font(58, "bold");
  ctx.fillText("URGENCE — SunuSanté", W / 2, y + 60);
  y += 200;

  ctx.font = font(72, "bold");
  const nameLines = wrapText(ctx, `${view.firstName} ${view.lastName}`, W - 120);
  for (const l of nameLines.slice(0, 2)) {
    ctx.fillText(l, W / 2, y);
    y += 86;
  }
  y += 20;

  // Infos vitales cochées (en clair, lisibles sans réseau)
  const qrSize = 460;
  const qrTop = H - qrSize - 190;
  const maxY = qrTop - 50;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const left = 80;
  const width = W - 160;
  outer: for (const line of emergencyLines(view).filter((l) => l.value)) {
    ctx.font = font(40, "bold");
    const label = `${line.label} : `;
    const labelW = ctx.measureText(label).width;
    ctx.font = font(40, line.strong || line.danger ? "bold" : "normal");
    const parts = wrapText(ctx, line.value, width - labelW);
    for (let i = 0; i < parts.length; i++) {
      if (y + 40 > maxY) {
        ctx.fillStyle = "#9ca3af";
        ctx.font = font(34, "normal");
        ctx.fillText("… suite sur la fiche (QR code)", left, y);
        break outer;
      }
      if (i === 0) {
        ctx.fillStyle = "#9ca3af";
        ctx.font = font(40, "bold");
        ctx.fillText(label, left, y);
      }
      ctx.fillStyle = line.danger ? "#f87171" : "#ffffff";
      ctx.font = font(40, line.strong || line.danger ? "bold" : "normal");
      ctx.fillText(parts[i], left + labelW, y);
      y += 54;
    }
    y += 10;
  }

  // QR code
  const qr = document.createElement("canvas");
  await QRCode.toCanvas(qr, url, { width: qrSize - 40, margin: 0, errorCorrectionLevel: "M" });
  ctx.fillStyle = "#ffffff";
  const qrLeft = (W - qrSize) / 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(qrLeft, qrTop, qrSize, qrSize, 24);
  else ctx.rect(qrLeft, qrTop, qrSize, qrSize);
  ctx.fill();
  ctx.drawImage(qr, qrLeft + 20, qrTop + 20, qrSize - 40, qrSize - 40);

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.font = font(42, "bold");
  ctx.fillText("Scannez pour la fiche à jour", W / 2, qrTop + qrSize + 80);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
