import crypto from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents, familyMemberships, members, treatmentMedications, treatments, users, vaccinations } from "../db/schema.js";
import { effectiveRole, ageOn } from "./family.js";
import { managersOf } from "../reminders/village.js";

// ── Outils communs au partage médecin et à la fiche d'urgence (phase F) ─────

export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

export const frontendUrl = () => (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");

const userCols = { id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified };

// Compte titulaire d'une fiche (relié à elle), avec son rôle effectif selon l'âge.
export async function holderOf(member) {
  const [row] = await db
    .select({ ...userCols, role: familyMemberships.role })
    .from(familyMemberships)
    .innerJoin(users, eq(users.id, familyMemberships.userId))
    .where(eq(familyMemberships.linkedMemberId, member.id));
  if (!row) return null;
  return { ...row, role: effectiveRole(row.role, member.dateOfBirth) };
}

// Destinataires des avis concernant une fiche : son titulaire ; pour un
// proche sans compte, ses gestionnaires (à défaut, les parents du foyer).
export async function recipientsFor(member) {
  const holder = await holderOf(member);
  if (holder) return [holder];
  return managersOf(member.id, member.familyId);
}

// Qui compose la fiche d'urgence (décision phase F) : le titulaire lui-même ;
// pour un proche sans compte — ou un adolescent, qui reste en lecture seule —
// toute personne ayant un accès complet au dossier (gestionnaire, parent).
export async function canComposeEmergency(req, member, canWrite) {
  const holder = await holderOf(member);
  if (holder && holder.role !== "dependent") return holder.id === req.user.id;
  return canWrite;
}

export const DOCTOR_SHARE_DURATIONS = { "2h": 2 * 3600e3, "24h": 24 * 3600e3, "7j": 7 * 24 * 3600e3 };

export function shareState(share, now = new Date()) {
  if (share.revokedAt) return "revoked";
  if (share.expiresAt <= now) return "expired";
  return share.consumedAt ? "opened" : "pending";
}

// Synthèse lisible par le professionnel de santé (UC-45 à 47) : uniquement
// les éléments cochés à la création du lien, jamais l'historique complet.
export async function doctorSynthesis(share) {
  const [m] = await db.select().from(members).where(eq(members.id, share.memberId));
  const out = {
    member: {
      firstName: m.firstName,
      lastName: m.lastName,
      dateOfBirth: m.dateOfBirth,
      age: ageOn(m.dateOfBirth),
      gender: m.gender,
    },
    expiresAt: share.expiresAt,
  };
  if (share.includeEssentials) {
    out.essentials = {
      bloodType: m.bloodType,
      allergies: m.allergies,
      doctorName: m.doctorName,
      doctorPhone: m.doctorPhone,
    };
  }
  if (share.includeTreatments) out.treatments = await activeTreatments(m.id);
  if (share.includeVaccinations) {
    out.vaccinations = await db
      .select({
        vaccineName: vaccinations.vaccineName,
        dateAdministered: vaccinations.dateAdministered,
        nextDoseDate: vaccinations.nextDoseDate,
        administeredBy: vaccinations.administeredBy,
        lotNumber: vaccinations.lotNumber,
      })
      .from(vaccinations)
      .where(eq(vaccinations.memberId, m.id))
      .orderBy(desc(vaccinations.dateAdministered));
  }
  if (share.documentIds.length > 0) {
    out.documents = await db
      .select({
        id: documents.id,
        title: documents.title,
        documentType: documents.documentType,
        description: documents.description,
        originalName: documents.originalName,
        uploadedAt: documents.uploadedAt,
        hasFile: documents.fileUrl,
      })
      .from(documents)
      .where(and(eq(documents.memberId, m.id), inArray(documents.id, share.documentIds)))
      .then((rows) => rows.map((d) => ({ ...d, hasFile: Boolean(d.hasFile) })));
  }
  return out;
}

export async function activeTreatments(memberId) {
  const rows = await db
    .select()
    .from(treatments)
    .where(and(eq(treatments.memberId, memberId), eq(treatments.isActive, true)))
    .orderBy(asc(treatments.startDate));
  if (rows.length === 0) return [];
  const meds = await db
    .select()
    .from(treatmentMedications)
    .where(inArray(treatmentMedications.treatmentId, rows.map((t) => t.id)));
  return rows.map((t) => ({
    disease: t.disease,
    startDate: t.startDate,
    endDate: t.endDate,
    prescribedBy: t.prescribedBy,
    medications: meds
      .filter((x) => x.treatmentId === t.id)
      .map((x) => ({ name: x.name, dosage: x.dosage, frequency: x.frequency, intakeTimes: x.intakeTimes })),
  }));
}

// ── Fiche d'urgence ──────────────────────────────────────────────────────────

export const EMERGENCY_FIELDS = ["showAge", "showBloodType", "showAllergies", "showTreatments", "showEmergencyContact", "showDoctor"];

// Ce que voit un inconnu : seulement les champs cochés (§5). Jamais
// d'historique, de documents ni de rendez-vous.
export async function emergencyPublicView(card, member) {
  const view = { firstName: member.firstName, lastName: member.lastName };
  if (card.showAge) view.age = ageOn(member.dateOfBirth);
  if (card.showBloodType) view.bloodType = member.bloodType || null;
  if (card.showAllergies) view.allergies = member.allergies || null;
  if (card.showTreatments) {
    view.treatments = (await activeTreatments(member.id)).map((t) => ({
      disease: t.disease,
      medications: t.medications.map((x) => ({ name: x.name, dosage: x.dosage })),
    }));
  }
  if (card.showEmergencyContact) {
    view.emergencyContact = {
      name: member.emergencyContactName || null,
      relation: member.emergencyContactRelation || null,
      phone: member.emergencyContactPhone || null,
    };
  }
  if (card.showDoctor) view.doctor = { name: member.doctorName || null, phone: member.doctorPhone || null };
  if (card.extraInfo) view.extraInfo = card.extraInfo;
  return view;
}
