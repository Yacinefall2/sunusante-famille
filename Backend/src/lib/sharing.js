import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents, emergencyCards, familyMemberships, members, treatmentMedications, treatments, users, vaccinations } from "../db/schema.js";
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

// Documents qu'un lien médecin laisse voir (synthèse ET téléchargement) :
// ceux cochés à sa création, de cette fiche. Un document confidentiel n'est
// montré que si le lien a été créé par le titulaire de la fiche (compte qui
// y est relié au moment de la consultation) : un document devenu confidentiel
// après l'envoi d'un lien par quelqu'un d'autre (A1, gestionnaire) disparaît
// de ce lien.
export async function sharedDocumentFilter(share, member) {
  const holder = await holderOf(member);
  const createdByHolder = Boolean(holder && share.createdByUserId === holder.id);
  return (doc) =>
    doc.memberId === share.memberId && share.documentIds.includes(doc.id) && (!doc.isConfidential || createdByHolder);
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
    const visible = await sharedDocumentFilter(share, m);
    out.documents = await db
      .select({
        id: documents.id,
        memberId: documents.memberId,
        title: documents.title,
        documentType: documents.documentType,
        description: documents.description,
        originalName: documents.originalName,
        uploadedAt: documents.uploadedAt,
        hasFile: documents.fileUrl,
        isConfidential: documents.isConfidential,
      })
      .from(documents)
      .where(and(eq(documents.memberId, m.id), inArray(documents.id, share.documentIds)))
      .then((rows) =>
        // eslint-disable-next-line no-unused-vars
        rows.filter(visible).map(({ memberId, isConfidential, ...d }) => ({ ...d, hasFile: Boolean(d.hasFile) }))
      );
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

// Jeton du QR code : jamais stocké en clair. La base garde son empreinte
// (token_hash, pour retrouver la fiche quand on scanne le QR code) et une
// copie chiffrée en AES-256-GCM (token_encrypted, pour que le titulaire
// puisse réafficher et réimprimer son QR code). Une copie de la base seule ne
// suffit donc pas à ouvrir les fiches d'urgence.
//
// Clé : dérivée (HKDF-SHA256) de EMERGENCY_TOKEN_KEY si elle est définie,
// sinon de JWT_ACCESS_SECRET. Changer ce secret rend les copies chiffrées
// illisibles : les QR codes déjà imprimés restent valables (empreinte), mais
// le lien n'est plus réaffichable — il faut alors régénérer le QR code.
const TOKEN_FORMAT = "v1";
let cachedKey = null;
function emergencyKey() {
  const secret = process.env.EMERGENCY_TOKEN_KEY || process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("EMERGENCY_TOKEN_KEY ou JWT_ACCESS_SECRET est requis pour chiffrer les jetons d'urgence");
  if (cachedKey?.secret !== secret) {
    const key = Buffer.from(crypto.hkdfSync("sha256", secret, "sunusante-famille", "jeton-fiche-urgence-v1", 32));
    cachedKey = { secret, key };
  }
  return cachedKey.key;
}

// La fiche (memberId) est liée au chiffré : une copie chiffrée recopiée sur
// une autre fiche ne se déchiffre pas.
const aadFor = (memberId) => Buffer.from(`emergency_card:${memberId}`);

export function encryptEmergencyToken(token, memberId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", emergencyKey(), iv);
  cipher.setAAD(aadFor(memberId));
  const encrypted = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
  return `${TOKEN_FORMAT}:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
}

export function decryptEmergencyToken(value, memberId) {
  if (typeof value !== "string" || !value.startsWith(`${TOKEN_FORMAT}:`)) return null;
  try {
    const raw = Buffer.from(value.slice(TOKEN_FORMAT.length + 1), "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", emergencyKey(), raw.subarray(0, 12));
    decipher.setAAD(aadFor(memberId));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null; // clé changée ou valeur altérée
  }
}

// Colonnes à enregistrer pour un (nouveau) jeton de fiche d'urgence.
export function emergencyTokenColumns(token, memberId) {
  return { token: null, tokenHash: hashToken(token), tokenEncrypted: encryptEmergencyToken(token, memberId) };
}

// Jeton en clair d'une fiche (pour afficher le QR code), ou null s'il n'est
// plus lisible.
export function emergencyTokenOf(card) {
  if (!card) return null;
  if (card.token) return card.token; // ancien jeton pas encore converti
  return decryptEmergencyToken(card.tokenEncrypted, card.memberId);
}

// Fiche encore au format d'avant (jeton en clair) : chiffre le jeton et vide
// la colonne. Renvoie la fiche à jour.
export async function upgradeEmergencyCard(card) {
  if (!card?.token) return card;
  const [updated] = await db
    .update(emergencyCards)
    .set(emergencyTokenColumns(card.token, card.memberId))
    .where(eq(emergencyCards.id, card.id))
    .returning();
  return updated ?? card;
}

// Conversion de toutes les anciennes fiches (lancée au démarrage du serveur,
// voir app.js) ; sans effet une fois tout converti.
export async function convertLegacyEmergencyTokens() {
  const legacy = await db.select().from(emergencyCards).where(isNotNull(emergencyCards.token));
  for (const card of legacy) await upgradeEmergencyCard(card);
  return legacy.length;
}

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
