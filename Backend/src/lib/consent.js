import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { consentAttestations, familyMemberships } from "../db/schema.js";
import { ADULT_AGE, ageOn } from "./family.js";
import { fullName } from "./activityLog.js";
import { isIsoDate, tooLong } from "./validation.js";
import { localDate } from "./time.js";

// ── Consentement oral du proche majeur (UC-28, UC-29, écran n°6, §10) ────────
// « À la création du dossier d'un proche majeur, le gestionnaire atteste
// avoir obtenu son accord verbal. L'attestation enregistre la date, l'heure
// et l'identité du déclarant. Pour un mineur, l'autorité parentale
// s'applique et aucune attestation n'est requise. »
//
// Règles retenues :
//   - l'attestation concerne toute fiche SANS compte relié dont la personne a
//     18 ans ou plus, ou dont l'âge est inconnu (pas de date de naissance) ;
//   - elle est BLOQUANTE à la création d'une telle fiche (routes/members.js) ;
//   - pour une fiche existante sans attestation (ou un mineur devenu majeur
//     sans compte), rien n'est bloqué : la fiche porte « Consentement à
//     attester » et le tableau de bord des parents le signale ;
//   - dès que la personne a son propre compte, elle gère elle-même son
//     dossier : plus d'attestation requise (l'historique est conservé) ;
//   - seul un compte avec accès complet à la fiche atteste (gestionnaire,
//     parent) — jamais un adolescent ;
//   - le retrait de l'accord archive la fiche ; un parent peut la réactiver
//     par une nouvelle attestation.

// Version du texte d'engagement affiché au déclarant (Frontend :
// components/members/ConsentAttestation.jsx). À changer avec le texte.
export const CONSENT_TEXT_VERSION = "2026-10-v1";

export const CONSENT_METHODS = ["en_personne", "telephone", "intermediaire"];

export const CONSENT_REQUIRED = "CONSENT_REQUIRED";
export const CONSENT_REQUIRED_ERROR =
  "Ce proche est majeur : attestez d'abord avoir obtenu son accord oral pour que son dossier soit suivi ici";
export const TEEN_CONSENT_ERROR = "Un compte adolescent ne peut pas attester le consentement d'un proche";

// Âge de la fiche : le consentement s'applique-t-il (majeur ou âge inconnu) ?
export function consentApplies(dateOfBirth, now = new Date()) {
  const age = ageOn(dateOfBirth, now);
  return age === null || age >= ADULT_AGE;
}

// Comparaison d'un nom tapé avec le nom du compte : sans accents, sans
// différence de casse, espaces multiples réduits.
export function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s ]+/g, " ")
    .trim();
}

// Un an avant `today` (AAAA-MM-JJ) : un 29 février devient le 28.
function oneYearBefore(today) {
  const [y, m, d] = today.split("-").map(Number);
  const date = new Date(Date.UTC(y - 1, m - 1, d));
  if (date.getUTCMonth() !== m - 1) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

// Vérifie l'attestation envoyée par le navigateur pour le compte `user`
// ({ id, name }). Renvoie { error } ou { values } prêtes à enregistrer
// (sans la fiche ni la famille).
export function parseAttestation(body, user) {
  if (!body || typeof body !== "object") return { error: CONSENT_REQUIRED_ERROR, code: CONSENT_REQUIRED };
  const text = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
  const method = body.method;
  const intermediaryName = text(body.intermediaryName);
  const signedName = text(body.signedName);
  const obtainedOn = body.obtainedOn;

  if (!CONSENT_METHODS.includes(method)) {
    return { error: "Indiquez comment l'accord a été obtenu (en personne, par téléphone ou par l'intermédiaire d'un proche)" };
  }
  if (method === "intermediaire" && !intermediaryName) {
    return { error: "Indiquez le nom du proche par l'intermédiaire de qui l'accord a été obtenu" };
  }
  const long = tooLong([
    [intermediaryName, 150, "Nom de l'intermédiaire"],
    [signedName, 150, "Signature"],
  ]);
  if (long) return { error: long };
  const today = localDate();
  if (!isIsoDate(obtainedOn)) return { error: "Date de l'accord invalide (format AAAA-MM-JJ attendu)" };
  if (obtainedOn > today) return { error: "La date de l'accord ne peut pas être dans le futur" };
  if (obtainedOn < oneYearBefore(today)) {
    return { error: "L'accord date de plus d'un an : demandez de nouveau son accord au proche avant d'attester" };
  }
  if (!signedName) return { error: "Signez en retapant votre nom complet" };
  if (normalizeName(signedName) !== normalizeName(user.name)) {
    return { error: `La signature doit être votre nom complet, tel qu'il figure sur votre compte : « ${user.name} »` };
  }
  return {
    values: {
      kind: "attestation",
      declarantUserId: user.id,
      declarantName: user.name,
      signedName,
      method,
      intermediaryName: method === "intermediaire" ? intermediaryName : null,
      obtainedOn,
      textVersion: CONSENT_TEXT_VERSION,
    },
  };
}

// Enregistre une attestation (ou un retrait) pour la fiche `member`.
// `executor` : db ou la transaction en cours.
export async function insertConsent(executor, member, values) {
  const [row] = await executor
    .insert(consentAttestations)
    .values({ ...values, familyId: member.familyId, memberId: member.id, memberName: fullName(member) })
    .returning();
  return row;
}

// Dernier engagement (attestation ou retrait) de chaque fiche demandée :
// Map memberId → ligne consent_attestations.
export async function latestConsents(memberIds) {
  if (memberIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(consentAttestations)
    .where(inArray(consentAttestations.memberId, memberIds))
    .orderBy(desc(consentAttestations.createdAt), desc(consentAttestations.id));
  const latest = new Map();
  for (const row of rows) if (!latest.has(row.memberId)) latest.set(row.memberId, row);
  return latest;
}

// Une fiche est-elle attestée (dernier engagement = attestation) ?
export async function isAttested(memberId) {
  const [row] = await db
    .select({ kind: consentAttestations.kind })
    .from(consentAttestations)
    .where(eq(consentAttestations.memberId, memberId))
    .orderBy(desc(consentAttestations.createdAt), desc(consentAttestations.id))
    .limit(1);
  return row?.kind === "attestation";
}

// La fiche est-elle reliée à un compte de la famille ?
export async function hasAccount(memberId) {
  const [row] = await db
    .select({ id: familyMemberships.id })
    .from(familyMemberships)
    .where(eq(familyMemberships.linkedMemberId, memberId));
  return Boolean(row);
}

// État du consentement d'une fiche non archivée, pour l'interface :
//   required    — attestation attendue (proche majeur ou d'âge inconnu, sans
//                 compte, pas d'attestation en vigueur)
//   attested    — une attestation est en vigueur
//   attestation — la dernière attestation (déclarant, date de l'accord,
//                 manière, horodatage) ou null
export function consentState(member, { linked, latest }) {
  const attested = latest?.kind === "attestation";
  return {
    required: !linked && consentApplies(member.dateOfBirth) && !attested,
    attested,
    attestation: attested
      ? {
          declarantName: latest.declarantName,
          obtainedAt: latest.obtainedOn,
          method: latest.method,
          intermediaryName: latest.intermediaryName,
          attestedAt: latest.createdAt,
        }
      : null,
  };
}
