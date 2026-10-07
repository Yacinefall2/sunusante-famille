import { DOCUMENT_TYPES, formatDate, formatDateTime } from "./utils";

// Export PDF du dossier partagé avec un professionnel de santé : un vrai
// document texte (sélectionnable, léger), téléchargé directement, sans passer
// par la boîte d'impression du navigateur.

const TEAL = [13, 148, 136];
const GRAY = [107, 114, 128];
const DARK = [17, 24, 39];
const MARGIN = 15;

const genderLabel = (g) => (g === "M" ? "Homme" : g === "F" ? "Femme" : null);
const docTypeLabel = (t) => DOCUMENT_TYPES.find((d) => d.value === t)?.label ?? t;

const slug = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

export async function downloadDoctorPdf(data) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const width = pageWidth - 2 * MARGIN;
  let y = 0;

  const ensure = (h) => {
    if (y + h > pageHeight - 18) {
      doc.addPage();
      y = MARGIN;
    }
  };
  const text = (str, { size = 10, bold = false, color = DARK, indent = 0, gap = 1.5 } = {}) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(String(str), width - indent);
    const lh = size * 0.42;
    ensure(lines.length * lh);
    doc.text(lines, MARGIN + indent, y + lh * 0.8);
    y += lines.length * lh + gap;
  };
  const section = (title) => {
    y += 4;
    ensure(12);
    doc.setFillColor(...TEAL);
    doc.rect(MARGIN, y, 1.2, 6, "F");
    text(title.toUpperCase(), { size: 11, bold: true, color: TEAL, indent: 4, gap: 3 });
  };
  const field = (label, value) => {
    text(label, { size: 8.5, color: GRAY, gap: 0.5 });
    text(value, { size: 10.5, bold: true, gap: 2.5 });
  };

  // En-tête
  doc.setFillColor(...TEAL);
  doc.rect(0, 0, pageWidth, 18, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(255, 255, 255);
  doc.text("Dossier partagé par la famille — SunuSanté Famille", MARGIN, 11.5);
  y = 28;

  // Identité
  const { member, essentials, treatments, vaccinations, documents } = data;
  text(`${member.firstName} ${member.lastName}`, { size: 20, bold: true, gap: 2 });
  const identity = [
    member.age != null ? `${member.age} ans` : null,
    member.dateOfBirth ? `né(e) le ${formatDate(member.dateOfBirth)}` : null,
    genderLabel(member.gender),
  ].filter(Boolean);
  if (identity.length) text(identity.join(" · "), { size: 10.5, color: GRAY, gap: 1.5 });
  text(`Accès valable jusqu'au ${formatDateTime(data.expiresAt)} — lecture seule`, { size: 9, color: [146, 64, 14] });

  if (essentials) {
    section("Essentiel");
    field("Groupe sanguin", essentials.bloodType || "Non renseigné");
    field("Allergies", essentials.allergies || "Aucune allergie renseignée");
    field(
      "Médecin traitant",
      [essentials.doctorName || "Non renseigné", essentials.doctorPhone].filter(Boolean).join(" — ")
    );
  }

  if (treatments) {
    section("Traitements en cours");
    if (treatments.length === 0) text("Aucun traitement en cours.", { color: GRAY });
    for (const t of treatments) {
      text(t.disease, { size: 11, bold: true, gap: 0.5 });
      const meta = [
        t.startDate && `Depuis le ${formatDate(t.startDate)}`,
        t.endDate && `jusqu'au ${formatDate(t.endDate)}`,
        t.prescribedBy && `prescrit par ${t.prescribedBy}`,
      ].filter(Boolean);
      if (meta.length) text(meta.join(" · "), { size: 8.5, color: GRAY, gap: 1 });
      for (const m of t.medications ?? []) {
        const parts = [m.name, m.dosage, m.frequency].filter(Boolean).join(" — ");
        const times = Array.isArray(m.intakeTimes) && m.intakeTimes.length ? ` (${m.intakeTimes.join(", ")})` : "";
        text(`•  ${parts}${times}`, { size: 10, indent: 3, gap: 1 });
      }
      y += 2;
    }
  }

  if (vaccinations) {
    section("Vaccinations");
    if (vaccinations.length === 0) {
      text("Aucune vaccination enregistrée.", { color: GRAY });
    } else {
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [["Vaccin", "Date", "Rappel", "Administré par", "Lot"]],
        body: vaccinations.map((v) => [
          v.vaccineName,
          formatDate(v.dateAdministered),
          v.nextDoseDate ? formatDate(v.nextDoseDate) : "—",
          v.administeredBy || "—",
          v.lotNumber || "—",
        ]),
        styles: { font: "helvetica", fontSize: 9, cellPadding: 2 },
        headStyles: { fillColor: TEAL, textColor: 255 },
        alternateRowStyles: { fillColor: [243, 244, 246] },
      });
      y = doc.lastAutoTable.finalY + 3;
    }
  }

  if (documents) {
    section("Documents");
    if (documents.length === 0) text("Aucun document disponible.", { color: GRAY });
    for (const d of documents) {
      text(d.title, { size: 10.5, bold: true, gap: 0.5 });
      const meta = [docTypeLabel(d.documentType), d.uploadedAt && `ajouté le ${formatDate(d.uploadedAt)}`, d.originalName].filter(Boolean);
      text(meta.join(" · "), { size: 8.5, color: GRAY, gap: d.description ? 0.5 : 2 });
      if (d.description) text(d.description, { size: 9.5, gap: 2 });
    }
    text("Les fichiers joints s'ouvrent depuis le lien de partage, tant qu'il est valide.", { size: 8.5, color: GRAY });
  }

  // Pied de page sur chaque page
  const pages = doc.getNumberOfPages();
  const footer = `Document confidentiel transmis par la famille via SunuSanté Famille — exporté le ${formatDateTime(new Date())}`;
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...GRAY);
    doc.text(footer, MARGIN, pageHeight - 8);
    doc.text(`${i} / ${pages}`, pageWidth - MARGIN, pageHeight - 8, { align: "right" });
  }

  doc.save(`dossier-${slug(member.firstName)}-${slug(member.lastName)}.pdf`);
}
