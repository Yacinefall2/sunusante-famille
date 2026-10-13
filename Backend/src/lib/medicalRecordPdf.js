import PDFDocument from "pdfkit";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { appointments, documents, medicationIntakes, members, treatmentMedications, treatments, vaccinations } from "../db/schema.js";
import { canSeeDocument } from "./documentAccess.js";
import { ageOn } from "./family.js";
import { APP_TIMEZONE, localDate } from "./time.js";
import { boosterStatus } from "../routes/vaccinations.js";

// ── Dossier médical en PDF (UC-27) ───────────────────────────────────────────
// Deux temps : loadMemberRecord() rassemble le contenu d'UN dossier tel que le
// compte qui exporte a le droit de le voir (documents confidentiels filtrés
// par canSeeDocument), puis renderMemberRecordPdf() le met en page (A4,
// en-tête et pied de page sur chaque page). Le même générateur sert au
// téléchargement d'un dossier et à l'archive de la famille (UC-09).
//
// Polices standard du PDF (Helvetica) : encodage WinAnsi, qui couvre les
// lettres accentuées du français, « œ », les guillemets « » et le tiret « — ».

const DAY_MS = 24 * 60 * 60 * 1000;
export const ADHERENCE_DAYS = 30;

// ── Mise en forme des dates (fuseau de l'application, format JJ/MM/AAAA) ─────

// Date du calendrier (AAAA-MM-JJ, colonnes « date » de la base) → JJ/MM/AAAA.
export function dayLabel(value) {
  if (!value) return null;
  if (value instanceof Date) return dayLabel(localDate(value));
  const [y, m, d] = String(value).slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : String(value);
}

// Instant → « JJ/MM/AAAA à HH:MM » (24 h) dans le fuseau de l'application.
export function dateTimeLabel(date) {
  if (!date) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: APP_TIMEZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(date))
      .map((p) => [p.type, p.value])
  );
  return `${parts.day}/${parts.month}/${parts.year} à ${parts.hour}:${parts.minute}`;
}

// Nom de fichier sûr : sans accents ni caractères spéciaux (« Aïssatou N'Diaye »
// → « Aissatou-N-Diaye »).
export function slugify(value, fallback = "sans-nom") {
  const slug = String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/œ/g, "oe")
    .replace(/Œ/g, "OE")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

export const fullName = (m) => `${m.firstName} ${m.lastName}`.trim();

// « dossier-awa-diop-2026-10-13.pdf »
export const memberPdfFilename = (member, now = new Date()) =>
  `dossier-${slugify(fullName(member)).toLowerCase()}-${localDate(now)}.pdf`;

// ── Libellés ──────────────────────────────────────────────────────────────────
const GENDER_LABELS = { M: "Homme", F: "Femme" };
export const DOCUMENT_TYPE_LABELS = {
  ordonnance: "Ordonnance",
  resultat: "Résultat d'analyse",
  radio: "Radiologie / Imagerie",
  "compte-rendu": "Compte-rendu médical",
  autre: "Autre",
};
const APPOINTMENT_STATUS_LABELS = { pending: "En attente", confirmed: "Confirmé", cancelled: "Annulé" };
const ATTENDANCE_LABELS = { attended: "s'y est rendu(e)", missed: "n'y est pas allé(e)" };
const BOOSTER_LABELS = { a_faire: "à faire", en_retard: "en retard", fait: "fait" };

// ── Données ───────────────────────────────────────────────────────────────────

// Observance par traitement sur les `days` derniers jours : part des prises
// « pris » parmi les prises dont l'issue est connue (pris, pas pris, sans
// réponse) — même calcul que le tableau de bord des parents.
async function adherenceByTreatment(memberId, now, days = ADHERENCE_DAYS) {
  const rows = await db
    .select({ treatmentId: treatmentMedications.treatmentId, status: medicationIntakes.status })
    .from(medicationIntakes)
    .innerJoin(treatmentMedications, eq(treatmentMedications.id, medicationIntakes.medicationId))
    .where(
      and(
        eq(medicationIntakes.memberId, memberId),
        gte(medicationIntakes.scheduledAt, new Date(now.getTime() - days * DAY_MS)),
        lte(medicationIntakes.scheduledAt, now),
        inArray(medicationIntakes.status, ["taken", "not_taken", "missed"])
      )
    );
  const out = new Map();
  for (const r of rows) {
    const a = out.get(r.treatmentId) ?? { taken: 0, total: 0 };
    a.total += 1;
    if (r.status === "taken") a.taken += 1;
    out.set(r.treatmentId, a);
  }
  for (const a of out.values()) a.pct = Math.round((a.taken / a.total) * 100);
  return out;
}

// Contenu complet d'un dossier, vu par `ctx` (requête, ou contexte équivalent
// avec user, familyId et membership). L'appelant a déjà vérifié que ce compte
// peut LIRE le dossier ; ici, seuls les documents confidentiels sont filtrés.
export async function loadMemberRecord(ctx, memberId, now = new Date()) {
  const [m] = await db.select().from(members).where(eq(members.id, memberId));
  if (!m) return null;

  const ts = await db.select().from(treatments).where(eq(treatments.memberId, m.id)).orderBy(desc(treatments.startDate), desc(treatments.id));
  const meds = ts.length
    ? await db
        .select()
        .from(treatmentMedications)
        .where(inArray(treatmentMedications.treatmentId, ts.map((t) => t.id)))
        .orderBy(treatmentMedications.id)
    : [];
  const adherence = await adherenceByTreatment(m.id, now);
  const treatmentRows = ts.map((t) => ({
    id: t.id,
    disease: t.disease,
    startDate: t.startDate,
    endDate: t.endDate,
    prescribedBy: t.prescribedBy,
    isActive: t.isActive,
    medications: meds
      .filter((x) => x.treatmentId === t.id)
      .map((x) => ({ name: x.name, dosage: x.dosage, frequency: x.frequency, duration: x.duration, intakeTimes: x.intakeTimes ?? [] })),
    adherence: adherence.get(t.id) ?? null,
  }));

  const today = localDate(now);
  const vaccs = (
    await db.select().from(vaccinations).where(eq(vaccinations.memberId, m.id)).orderBy(desc(vaccinations.dateAdministered))
  ).map((v) => ({
    vaccineName: v.vaccineName,
    dateAdministered: v.dateAdministered,
    nextDoseDate: v.nextDoseDate,
    boosterStatus: boosterStatus(v, today),
    administeredBy: v.administeredBy,
    lotNumber: v.lotNumber,
  }));

  const appts = await db.select().from(appointments).where(eq(appointments.memberId, m.id)).orderBy(asc(appointments.appointmentDate));
  const presentAppt = (a) => ({
    title: a.title,
    doctorName: a.doctorName,
    location: a.location,
    appointmentDate: a.appointmentDate,
    status: a.status,
    attendance: a.attendance,
  });

  const docs = (await db.select().from(documents).where(eq(documents.memberId, m.id)).orderBy(desc(documents.uploadedAt)))
    .filter((d) => canSeeDocument(ctx, d))
    .map((d) => ({
      id: d.id,
      title: d.title,
      documentType: d.documentType,
      description: d.description,
      uploadedAt: d.uploadedAt,
      isConfidential: d.isConfidential,
      fileUrl: d.fileUrl,
      originalName: d.originalName,
    }));

  return {
    member: {
      id: m.id,
      firstName: m.firstName,
      lastName: m.lastName,
      dateOfBirth: m.dateOfBirth,
      age: ageOn(m.dateOfBirth, now),
      gender: m.gender,
      phone: m.phone,
      bloodType: m.bloodType,
      allergies: m.allergies,
      notes: m.notes,
      doctorName: m.doctorName,
      doctorPhone: m.doctorPhone,
      emergencyContactName: m.emergencyContactName,
      emergencyContactRelation: m.emergencyContactRelation,
      emergencyContactPhone: m.emergencyContactPhone,
    },
    treatments: {
      active: treatmentRows.filter((t) => t.isActive),
      finished: treatmentRows.filter((t) => !t.isActive),
    },
    vaccinations: vaccs,
    appointments: {
      upcoming: appts.filter((a) => a.appointmentDate >= now).map(presentAppt),
      past: appts
        .filter((a) => a.appointmentDate < now)
        .reverse()
        .map(presentAppt),
    },
    documents: docs,
  };
}

// ── Mise en page ──────────────────────────────────────────────────────────────

const COLORS = { brand: "#0d9488", text: "#1f2937", muted: "#6b7280", line: "#d1d5db", danger: "#b91c1c" };
const MARGINS = { top: 70, bottom: 65, left: 50, right: 50 };

// Document PDF A4 dont les pages sont gardées en mémoire, pour poser l'en-tête
// et le pied de page (« page x/y ») une fois le nombre de pages connu.
function newDocument(title, author) {
  return new PDFDocument({
    size: "A4",
    margins: MARGINS,
    bufferPages: true,
    info: { Title: title, Author: author, Creator: "SunuSanté Famille", Producer: "SunuSanté Famille" },
  });
}

// En-tête et pied de page de toutes les pages, puis fin du document. Renvoie
// le contenu du PDF (Buffer).
function finish(doc, { header, footer }) {
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const { width, height } = doc.page;
    // Écrire dans les marges sans déclencher de saut de page automatique.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.brand);
    doc.text(header, MARGINS.left, 30, { width: width - MARGINS.left - MARGINS.right, lineBreak: false, ellipsis: true });
    doc
      .moveTo(MARGINS.left, 46)
      .lineTo(width - MARGINS.right, 46)
      .lineWidth(0.5)
      .strokeColor(COLORS.line)
      .stroke();
    doc
      .moveTo(MARGINS.left, height - 48)
      .lineTo(width - MARGINS.right, height - 48)
      .lineWidth(0.5)
      .strokeColor(COLORS.line)
      .stroke();
    doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted);
    doc.text(`${footer} — page ${i - range.start + 1}/${range.count}`, MARGINS.left, height - 40, {
      width: width - MARGINS.left - MARGINS.right,
      align: "center",
      lineBreak: false,
      ellipsis: true,
    });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}

// Saut de page si moins de `needed` points restent sur la page.
function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function contentWidth(doc) {
  return doc.page.width - MARGINS.left - MARGINS.right;
}

function sectionTitle(doc, title) {
  ensureSpace(doc, 60);
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(13).fillColor(COLORS.brand).text(title, MARGINS.left, doc.y, { width: contentWidth(doc) });
  const y = doc.y + 2;
  doc.moveTo(MARGINS.left, y).lineTo(MARGINS.left + contentWidth(doc), y).lineWidth(0.8).strokeColor(COLORS.brand).stroke();
  doc.moveDown(0.6);
  doc.fillColor(COLORS.text);
}

function subTitle(doc, title) {
  ensureSpace(doc, 40);
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.text).text(title, MARGINS.left, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.3);
}

// « Libellé : valeur » ; valeur absente → « non renseigné(e) ».
function field(doc, label, value, { indent = 0, missing = "non renseigné" } = {}) {
  const x = MARGINS.left + indent;
  doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.text);
  doc.text(`${label} : `, x, doc.y, { width: contentWidth(doc) - indent, continued: true });
  const empty = value === null || value === undefined || String(value).trim() === "";
  doc.font("Helvetica").fillColor(empty ? COLORS.muted : COLORS.text).text(empty ? missing : String(value));
  doc.fillColor(COLORS.text);
}

function emptyLine(doc, text) {
  doc.font("Helvetica-Oblique").fontSize(10).fillColor(COLORS.muted).text(text, MARGINS.left, doc.y, { width: contentWidth(doc) });
  doc.fillColor(COLORS.text);
}

// Élément d'une liste : titre en gras, puis lignes de détail en retrait.
function item(doc, title, lines, { badge } = {}) {
  ensureSpace(doc, 30 + lines.length * 13);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(COLORS.text);
  doc.text(`• ${title}`, MARGINS.left, doc.y, { width: contentWidth(doc), continued: Boolean(badge) });
  if (badge) doc.font("Helvetica-Bold").fillColor(COLORS.danger).text(`  ${badge}`);
  doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.text);
  for (const line of lines.filter(Boolean)) {
    doc.text(line, MARGINS.left + 14, doc.y, { width: contentWidth(doc) - 14 });
  }
  doc.moveDown(0.5);
}

const joinParts = (parts) => parts.filter(Boolean).join(" · ");

function treatmentItem(doc, t) {
  const period = joinParts([
    t.startDate ? `du ${dayLabel(t.startDate)}` : null,
    t.endDate ? `au ${dayLabel(t.endDate)}` : null,
  ]);
  const lines = [
    joinParts([period ? `Période : ${period}` : null, t.prescribedBy ? `Prescrit par : ${t.prescribedBy}` : null]),
    ...t.medications.map(
      (x) =>
        `– ${joinParts([
          x.name,
          x.dosage,
          x.frequency,
          x.duration ? `pendant ${x.duration}` : null,
          x.intakeTimes.length ? `à ${x.intakeTimes.join(", ")}` : null,
        ])}`
    ),
    t.adherence
      ? `Observance sur ${ADHERENCE_DAYS} jours : ${t.adherence.pct} % (${t.adherence.taken} prise${t.adherence.taken > 1 ? "s" : ""} sur ${t.adherence.total})`
      : null,
  ];
  if (t.medications.length === 0) lines.push("Aucun médicament enregistré");
  item(doc, t.disease, lines);
}

function appointmentItem(doc, a, { past }) {
  const lines = [
    joinParts([a.doctorName ? `Médecin : ${a.doctorName}` : null, a.location ? `Lieu : ${a.location}` : null]),
    joinParts([
      `Statut : ${APPOINTMENT_STATUS_LABELS[a.status] ?? a.status}`,
      past && a.status !== "cancelled" ? `Présence : ${ATTENDANCE_LABELS[a.attendance] ?? "non renseignée"}` : null,
    ]),
  ];
  item(doc, `${dateTimeLabel(a.appointmentDate)} — ${a.title}`, lines);
}

function vaccinationItem(doc, v) {
  const booster = v.nextDoseDate ? `Rappel : ${dayLabel(v.nextDoseDate)} (${BOOSTER_LABELS[v.boosterStatus] ?? v.boosterStatus})` : "Aucun rappel prévu";
  item(doc, `${dayLabel(v.dateAdministered)} — ${v.vaccineName}`, [
    booster,
    joinParts([v.administeredBy ? `Administré par : ${v.administeredBy}` : null, v.lotNumber ? `Lot : ${v.lotNumber}` : null]),
  ]);
}

// PDF du dossier médical (Buffer). `exportedBy` : nom du compte qui exporte.
export async function renderMemberRecordPdf(record, { exportedBy, exportedAt = new Date() }) {
  const name = fullName(record.member);
  const m = record.member;
  const doc = newDocument(`Dossier médical de ${name}`, exportedBy);

  doc.font("Helvetica-Bold").fontSize(20).fillColor(COLORS.text).text(`Dossier médical de ${name}`);
  doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.muted);
  doc.text(`Exporté le ${dateTimeLabel(exportedAt)} par ${exportedBy}. Document confidentiel : il contient des données de santé.`);
  doc.fillColor(COLORS.text);

  sectionTitle(doc, "Identité");
  field(doc, "Nom", name);
  field(doc, "Date de naissance", m.dateOfBirth ? `${dayLabel(m.dateOfBirth)}${m.age != null ? ` (${m.age} an${m.age > 1 ? "s" : ""})` : ""}` : null, { missing: "non renseignée" });
  field(doc, "Sexe", GENDER_LABELS[m.gender] ?? null);
  if (m.phone) field(doc, "Téléphone", m.phone);

  sectionTitle(doc, "L'essentiel");
  field(doc, "Groupe sanguin", m.bloodType, { missing: "non connu" });
  field(doc, "Allergies", m.allergies, { missing: "aucune allergie connue" });
  field(doc, "Notes médicales", m.notes, { missing: "aucune" });
  field(doc, "Médecin traitant", joinParts([m.doctorName, m.doctorPhone]));
  field(
    doc,
    "Contact d'urgence",
    joinParts([[m.emergencyContactName, m.emergencyContactRelation ? `(${m.emergencyContactRelation})` : null].filter(Boolean).join(" ") || null, m.emergencyContactPhone])
  );

  sectionTitle(doc, "Traitements");
  subTitle(doc, "En cours");
  if (record.treatments.active.length === 0) emptyLine(doc, "Aucun traitement en cours enregistré");
  for (const t of record.treatments.active) treatmentItem(doc, t);
  subTitle(doc, "Terminés");
  if (record.treatments.finished.length === 0) emptyLine(doc, "Aucun traitement terminé enregistré");
  for (const t of record.treatments.finished) treatmentItem(doc, t);

  sectionTitle(doc, "Vaccinations");
  if (record.vaccinations.length === 0) emptyLine(doc, "Aucune vaccination enregistrée");
  for (const v of record.vaccinations) vaccinationItem(doc, v);

  sectionTitle(doc, "Rendez-vous");
  subTitle(doc, "À venir");
  if (record.appointments.upcoming.length === 0) emptyLine(doc, "Aucun rendez-vous à venir enregistré");
  for (const a of record.appointments.upcoming) appointmentItem(doc, a, { past: false });
  subTitle(doc, "Passés");
  if (record.appointments.past.length === 0) emptyLine(doc, "Aucun rendez-vous passé enregistré");
  for (const a of record.appointments.past) appointmentItem(doc, a, { past: true });

  sectionTitle(doc, "Documents");
  doc.font("Helvetica-Oblique").fontSize(9).fillColor(COLORS.muted);
  doc.text("Liste des documents du dossier (les fichiers eux-mêmes ne sont pas inclus dans ce PDF).");
  doc.moveDown(0.4);
  if (record.documents.length === 0) emptyLine(doc, "Aucun document enregistré");
  for (const d of record.documents) {
    item(doc, d.title, [joinParts([DOCUMENT_TYPE_LABELS[d.documentType] ?? d.documentType, `ajouté le ${dayLabel(d.uploadedAt)}`])], {
      badge: d.isConfidential ? "confidentiel" : null,
    });
  }

  return finish(doc, {
    header: `SunuSanté Famille — Dossier médical de ${name}`,
    footer: `Document confidentiel — exporté le ${dateTimeLabel(exportedAt)} par ${exportedBy}`,
  });
}

// PDF du journal d'activité (archive de la famille) : `entries` déjà mises en
// forme par presentEntries (texte prêt à afficher), du plus récent au plus ancien.
export async function renderJournalPdf({ familyName, entries, categories, exportedBy, exportedAt = new Date() }) {
  const doc = newDocument(`Journal d'activité — ${familyName}`, exportedBy);
  doc.font("Helvetica-Bold").fontSize(20).fillColor(COLORS.text).text(`Journal d'activité — ${familyName}`);
  doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.muted);
  doc.text(
    `Exporté le ${dateTimeLabel(exportedAt)} par ${exportedBy}. Seules les entrées visibles par ce compte figurent ici ` +
      "(le journal ne contient aucune donnée médicale)."
  );
  doc.moveDown(0.8);
  if (entries.length === 0) emptyLine(doc, "Aucune activité enregistrée");
  for (const e of entries) {
    ensureSpace(doc, 34);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.muted);
    doc.text(joinParts([dateTimeLabel(e.occurredAt), categories[e.category] ?? null]), MARGINS.left, doc.y, { width: contentWidth(doc) });
    doc.font("Helvetica").fontSize(10).fillColor(COLORS.text).text(e.text, MARGINS.left, doc.y, { width: contentWidth(doc) });
    doc.moveDown(0.5);
  }
  return finish(doc, {
    header: `SunuSanté Famille — Journal d'activité de la famille ${familyName}`,
    footer: `Document confidentiel — exporté le ${dateTimeLabel(exportedAt)} par ${exportedBy}`,
  });
}
