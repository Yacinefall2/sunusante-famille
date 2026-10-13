import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ZipArchive } from "archiver";
import { and, desc, eq, gte, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  activityLog,
  appointments,
  documentRoles,
  families,
  familyExports,
  familyMemberships,
  medicationIntakes,
  members,
  treatmentMedications,
  treatments,
  users,
  vaccinations,
} from "../db/schema.js";
import { UPLOAD_DIR_PATH } from "../middleware/upload.js";
import { canRead, getFamilyAccess, membershipOf } from "./documentAccess.js";
import { CATEGORIES, logActivity, presentEntries } from "./activityLog.js";
import { journalScope } from "./journalScope.js";
import { effectiveRole } from "./family.js";
import { hashToken } from "./session.js";
import { generateToken } from "./token.js";
import { localDate } from "./time.js";
import { sendFamilyExportEmail } from "./mailer.js";
import { notify } from "../reminders/notify.js";
import { boosterStatus } from "../routes/vaccinations.js";
import {
  DOCUMENT_TYPE_LABELS,
  dateTimeLabel,
  fullName,
  loadMemberRecord,
  renderJournalPdf,
  renderMemberRecordPdf,
  slugify,
} from "./medicalRecordPdf.js";

// ── Export des données de la famille (UC-09) ─────────────────────────────────
// Un parent demande l'archive (routes/exports.js, mot de passe exigé) ; elle
// est préparée en arrière-plan — tout de suite par le serveur, et à défaut par
// le worker à son passage suivant (exportsTick) — puis un lien à usage unique,
// valable 1 heure, part par courriel au demandeur. L'archive ne contient QUE
// ce que ce parent peut lire : jamais la fiche de l'autre parent (sauf
// délégation), jamais une fiche archivée, jamais un document confidentiel
// qu'il ne peut pas voir.
//
// Les archives sont écrites dans uploads/exports/ (volume des fichiers) :
// ce dossier n'est jamais servi par /uploads (qui ne sert que les fichiers
// rattachés à un document). Fichier effacé après le téléchargement, à
// l'expiration du lien, ou en cas d'échec.

export const EXPORT_DIR = path.join(UPLOAD_DIR_PATH, "exports");
export const EXPORT_LINK_TTL_MS = 60 * 60 * 1000; // 1 heure
export const MAX_EXPORTS_PER_DAY = 3; // par demandeur, sur 24 heures glissantes
export const INTAKE_HISTORY_DAYS = 365; // prises des 12 derniers mois dans le JSON
const CLAIM_STALE_MS = 15 * 60 * 1000; // préparation bloquée : reprise par le worker
const PENDING_GIVE_UP_MS = 2 * 60 * 60 * 1000; // au-delà : demande abandonnée (échec)
const DAY_MS = 24 * 60 * 60 * 1000;

export const exportFilePath = (name) => path.join(EXPORT_DIR, path.basename(name));

async function removeExportFile(name) {
  if (name) await fsp.unlink(exportFilePath(name)).catch(() => {});
}

// Contexte d'accès d'un compte dans une famille, comme une requête HTTP
// passée par requireFamilyMembership (user, familyId, membership avec le
// rôle EFFECTIF) : il sert aux mêmes fonctions de contrôle d'accès.
export async function accessContext(userId, familyId) {
  const [user] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
  if (!user) return null;
  const membership = await membershipOf(userId, familyId);
  if (!membership) return null;
  return { user, familyId, membership };
}

// Noms uniques dans l'archive : « Awa-Diop », « Awa-Diop-2 »…
function uniqueName(taken, base, ext = "") {
  let name = `${base}${ext}`;
  for (let i = 2; taken.has(name); i += 1) name = `${base}-${i}${ext}`;
  taken.add(name);
  return name;
}

const ROLE_LABELS = { parent: "Parent (administrateur)", adult: "Membre adulte", dependent: "Membre adolescent" };
const DOC_ROLE_LABELS = { gestionnaire: "Gestionnaire", relais: "Relais", lecteur_invite: "Lecteur invité" };

function readme({ familyName, exportedBy, exportedAt, fiches, filesCount, missingFiles }) {
  const lines = [
    "SunuSanté Famille — Archive des données de la famille",
    "=====================================================",
    "",
    `Famille : ${familyName}`,
    `Exportée le ${dateTimeLabel(exportedAt)} par ${exportedBy}.`,
    "",
    "ATTENTION : DONNÉES DE SANTÉ CONFIDENTIELLES",
    "Cette archive contient des informations médicales personnelles. Conservez-la dans un endroit sûr",
    "(dossier protégé, support chiffré), ne la transmettez qu'à des personnes de confiance, et supprimez-la",
    "lorsque vous n'en avez plus besoin.",
    "",
    "CONTENU",
    `- dossiers/ : un PDF par dossier médical (${fiches.length}) — identité, l'essentiel, traitements,`,
    "  vaccinations, rendez-vous et liste des documents.",
    `- documents/ : les fichiers des documents médicaux (${filesCount}), rangés par personne`,
    "  (date d'ajout, puis titre du document).",
    "- donnees-famille.json : les mêmes données sous forme structurée (famille, comptes, dossiers, traitements,",
    "  médicaments, prises des 12 derniers mois, vaccinations, rendez-vous, documents, rôles sur les dossiers,",
    "  journal d'activité).",
    "- journal-activite.pdf : le journal d'activité de la famille.",
    "",
    "DOSSIERS INCLUS",
    ...(fiches.length ? fiches.map((f) => `- ${f}`) : ["- aucun"]),
    "",
    "CE QUE L'ARCHIVE NE CONTIENT PAS",
    `Uniquement ce que ${exportedBy} peut consulter dans l'application : ni le dossier de l'autre parent`,
    "(sauf s'il en a délégué l'accès), ni les fiches archivées, ni les documents confidentiels réservés à",
    "leur titulaire. Aucun mot de passe ni aucun jeton de connexion n'y figure.",
  ];
  if (missingFiles > 0) {
    lines.push("", `Remarque : ${missingFiles} fichier(s) de document introuvable(s) sur le serveur n'ont pas pu être joints.`);
  }
  return `${lines.join("\r\n")}\r\n`;
}

// Écrit l'archive ZIP de la famille, vue par `ctx`, dans `outPath`.
// Renvoie { sizeBytes, fichesCount, filesCount }.
export async function buildFamilyArchive(ctx, outPath, now = new Date()) {
  const [family] = await db.select().from(families).where(eq(families.id, ctx.familyId));
  const access = await getFamilyAccess(ctx);
  const readableIds = [...access].filter(([, level]) => canRead(level)).map(([id]) => id);
  const fiches = readableIds.length
    ? await db.select().from(members).where(inArray(members.id, readableIds)).orderBy(members.id)
    : [];
  const exportedBy = ctx.user.name;

  const archive = new ZipArchive({ zlib: { level: 6 } });
  const output = fs.createWriteStream(outPath, { mode: 0o600 });
  const closed = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(output);

  const takenPdf = new Set();
  const takenDirs = new Set();
  const ficheNames = [];
  const fichesJson = [];
  let filesCount = 0;
  let missingFiles = 0;

  // Prises des 12 derniers mois, par médicament.
  const intakes = readableIds.length
    ? await db
        .select()
        .from(medicationIntakes)
        .where(
          and(
            inArray(medicationIntakes.memberId, readableIds),
            gte(medicationIntakes.scheduledAt, new Date(now.getTime() - INTAKE_HISTORY_DAYS * DAY_MS))
          )
        )
        .orderBy(medicationIntakes.scheduledAt)
    : [];
  // Rôles sur les dossiers lisibles.
  const roles = readableIds.length
    ? await db
        .select({ memberId: documentRoles.memberId, role: documentRoles.role, expiresAt: documentRoles.expiresAt, name: users.name })
        .from(documentRoles)
        .innerJoin(users, eq(users.id, documentRoles.userId))
        .where(inArray(documentRoles.memberId, readableIds))
    : [];
  // Comptes de la famille (rôle effectif), sans mot de passe ni jeton.
  const accounts = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: familyMemberships.role,
      isPrimaryAdmin: familyMemberships.isPrimaryAdmin,
      linkedMemberId: familyMemberships.linkedMemberId,
      joinedAt: familyMemberships.createdAt,
    })
    .from(familyMemberships)
    .innerJoin(users, eq(users.id, familyMemberships.userId))
    .where(eq(familyMemberships.familyId, ctx.familyId))
    .orderBy(familyMemberships.id);
  const allFiches = await db
    .select({ id: members.id, firstName: members.firstName, lastName: members.lastName, dateOfBirth: members.dateOfBirth })
    .from(members)
    .where(eq(members.familyId, ctx.familyId));
  const ficheById = new Map(allFiches.map((m) => [m.id, m]));

  for (const fiche of fiches) {
    const record = await loadMemberRecord(ctx, fiche.id, now);
    const base = slugify(fullName(fiche));
    const pdfName = uniqueName(takenPdf, `dossiers/${base}`, ".pdf");
    archive.append(await renderMemberRecordPdf(record, { exportedBy, exportedAt: now }), { name: pdfName, date: now });
    ficheNames.push(fullName(fiche));

    // Fichiers des documents (ceux que ce compte peut voir : record.documents).
    const dir = uniqueName(takenDirs, `documents/${base}`);
    const takenFiles = new Set();
    const documentsJson = [];
    for (const d of record.documents) {
      let fichier = null;
      if (d.fileUrl) {
        const source = path.join(UPLOAD_DIR_PATH, path.basename(d.fileUrl));
        const exists = await fsp.stat(source).then((s) => s.isFile()).catch(() => false);
        if (exists) {
          const ext = path.extname(d.fileUrl).toLowerCase();
          fichier = uniqueName(takenFiles, `${dir}/${localDate(d.uploadedAt)}-${slugify(d.title, "document").toLowerCase()}`, ext);
          archive.file(source, { name: fichier, date: d.uploadedAt });
          filesCount += 1;
        } else {
          missingFiles += 1;
        }
      }
      documentsJson.push({
        titre: d.title,
        type: DOCUMENT_TYPE_LABELS[d.documentType] ?? d.documentType,
        description: d.description,
        ajouteLe: d.uploadedAt,
        confidentiel: d.isConfidential,
        fichierOriginal: d.originalName,
        fichierDansArchive: fichier,
        fichierManquant: Boolean(d.fileUrl) && !fichier,
      });
    }

    // Données structurées du dossier.
    const treatmentRows = await db.select().from(treatments).where(eq(treatments.memberId, fiche.id)).orderBy(treatments.id);
    const meds = treatmentRows.length
      ? await db
          .select()
          .from(treatmentMedications)
          .where(inArray(treatmentMedications.treatmentId, treatmentRows.map((t) => t.id)))
          .orderBy(treatmentMedications.id)
      : [];
    const adherence = new Map([...record.treatments.active, ...record.treatments.finished].map((t) => [t.id, t.adherence]));
    fichesJson.push({
      identite: {
        prenom: fiche.firstName,
        nom: fiche.lastName,
        dateDeNaissance: fiche.dateOfBirth,
        age: record.member.age,
        sexe: fiche.gender,
        lienDeParente: fiche.kinship,
        statut: fiche.status,
        telephone: fiche.phone,
        creeeLe: fiche.createdAt,
      },
      donneesMedicales: {
        groupeSanguin: fiche.bloodType,
        allergies: fiche.allergies,
        notes: fiche.notes,
        medecinTraitant: { nom: fiche.doctorName, telephone: fiche.doctorPhone },
        contactUrgence: {
          nom: fiche.emergencyContactName,
          lien: fiche.emergencyContactRelation,
          telephone: fiche.emergencyContactPhone,
        },
      },
      traitements: treatmentRows.map((t) => ({
        maladie: t.disease,
        debut: t.startDate,
        fin: t.endDate,
        prescritPar: t.prescribedBy,
        enCours: t.isActive,
        notes: t.notes,
        observance30Jours: adherence.get(t.id) ?? null,
        medicaments: meds
          .filter((x) => x.treatmentId === t.id)
          .map((x) => ({
            nom: x.name,
            dosage: x.dosage,
            frequence: x.frequency,
            duree: x.duration,
            heuresDePrise: x.intakeTimes,
            prises12DerniersMois: intakes
              .filter((i) => i.medicationId === x.id)
              .map((i) => ({ prevueLe: i.scheduledAt, statut: i.status, reponduLe: i.respondedAt })),
          })),
      })),
      vaccinations: (await db.select().from(vaccinations).where(eq(vaccinations.memberId, fiche.id)).orderBy(vaccinations.dateAdministered)).map(
        (v) => ({
          vaccin: v.vaccineName,
          date: v.dateAdministered,
          rappelPrevu: v.nextDoseDate,
          statutRappel: boosterStatus(v, localDate(now)),
          administrePar: v.administeredBy,
          lot: v.lotNumber,
          notes: v.notes,
        })
      ),
      rendezVous: (await db.select().from(appointments).where(eq(appointments.memberId, fiche.id)).orderBy(appointments.appointmentDate)).map(
        (a) => ({
          titre: a.title,
          date: a.appointmentDate,
          medecin: a.doctorName,
          lieu: a.location,
          statut: a.status,
          presence: a.attendance,
          notes: a.notes,
        })
      ),
      documents: documentsJson,
      rolesSurLeDossier: roles
        .filter((r) => r.memberId === fiche.id)
        .map((r) => ({ compte: r.name, role: DOC_ROLE_LABELS[r.role] ?? r.role, expireLe: r.expiresAt })),
    });
  }

  // Journal d'activité, tel que ce compte peut le voir.
  const { condition } = await journalScope(ctx);
  const journalRows = condition
    ? await db
        .select()
        .from(activityLog)
        .where(and(...condition))
        .orderBy(desc(activityLog.occurredAt), desc(activityLog.id))
    : [];
  const journal = await presentEntries(journalRows);
  archive.append(await renderJournalPdf({ familyName: family.name, entries: journal, categories: CATEGORIES, exportedBy, exportedAt: now }), {
    name: "journal-activite.pdf",
    date: now,
  });

  const data = {
    exporteLe: now.toISOString(),
    exportePar: { nom: ctx.user.name, email: ctx.user.email },
    famille: { nom: family.name, creeeLe: family.createdAt },
    comptes: accounts.map((a) => {
      const linked = a.linkedMemberId ? ficheById.get(a.linkedMemberId) : null;
      return {
        nom: a.name,
        email: a.email,
        role: ROLE_LABELS[effectiveRole(a.role, linked?.dateOfBirth)] ?? a.role,
        administrateurFamilial: a.isPrimaryAdmin,
        fiche: linked ? fullName(linked) : null,
        membreDepuis: a.joinedAt,
      };
    }),
    fiches: fichesJson,
    journal: journal.map((e) => ({ date: e.occurredAt, categorie: CATEGORIES[e.category] ?? null, texte: e.text, fiche: e.memberName })),
  };
  archive.append(JSON.stringify(data, null, 2), { name: "donnees-famille.json", date: now });
  archive.append(readme({ familyName: family.name, exportedBy, exportedAt: now, fiches: ficheNames, filesCount, missingFiles }), {
    name: "LISEZMOI.txt",
    date: now,
  });

  await archive.finalize();
  await closed;
  const { size } = await fsp.stat(outPath);
  return { sizeBytes: size, fichesCount: fiches.length, filesCount };
}

// Marque une demande en échec : fichier effacé, trace au journal.
async function failExport(row, error, now) {
  console.error("Export de la famille impossible :", error);
  await db
    .update(familyExports)
    .set({ status: "failed", error: String(error?.message ?? error).slice(0, 500), filePath: null, tokenHash: null })
    .where(eq(familyExports.id, row.id));
  await removeExportFile(row.filePath);
  await logActivity({ familyId: row.familyId, actor: row.requestedByUserId, action: "family_export_failed", at: now });
}

// Prépare l'archive d'une demande en attente : construction du ZIP, lien
// envoyé par courriel au demandeur, autres parents prévenus, journal.
// Sans effet si la demande n'est plus en attente ou si une autre préparation
// est déjà en cours (prise en charge atomique). Renvoie la demande à jour, ou null.
export async function prepareFamilyExport(exportId, { now = new Date(), sendMail = sendFamilyExportEmail } = {}) {
  const fileName = `${exportId}-${crypto.randomUUID()}.zip`;
  const [row] = await db
    .update(familyExports)
    .set({ claimedAt: now, filePath: fileName })
    .where(
      and(
        eq(familyExports.id, exportId),
        eq(familyExports.status, "pending"),
        or(isNull(familyExports.claimedAt), lt(familyExports.claimedAt, new Date(now.getTime() - CLAIM_STALE_MS)))
      )
    )
    .returning();
  if (!row) return null;

  try {
    const ctx = await accessContext(row.requestedByUserId, row.familyId);
    // Le demandeur doit toujours être parent de la famille au moment de la préparation.
    if (!ctx || ctx.membership.role !== "parent") throw new Error("Le demandeur n'est plus parent de cette famille");

    await fsp.mkdir(EXPORT_DIR, { recursive: true });
    const stats = await buildFamilyArchive(ctx, exportFilePath(fileName), now);

    const token = generateToken();
    const expiresAt = new Date(now.getTime() + EXPORT_LINK_TTL_MS);
    const [ready] = await db
      .update(familyExports)
      .set({ status: "ready", tokenHash: hashToken(token), sizeBytes: stats.sizeBytes, readyAt: now, expiresAt, error: null })
      .where(and(eq(familyExports.id, row.id), eq(familyExports.status, "pending")))
      .returning();
    if (!ready) {
      // Demande annulée entre-temps : l'archive ne sert plus.
      await removeExportFile(fileName);
      return null;
    }

    const [family] = await db.select({ name: families.name }).from(families).where(eq(families.id, row.familyId));
    await sendMail({ to: ctx.user.email, name: ctx.user.name, familyName: family.name, token, expiresAtLabel: dateTimeLabel(expiresAt) });

    await logActivity({
      familyId: row.familyId,
      actor: ctx.user,
      action: "family_export_sent",
      details: { fichesCount: stats.fichesCount, filesCount: stats.filesCount },
      at: now,
    });

    // Les autres parents sont prévenus (dans l'application et par courriel).
    const otherParents = await db
      .select({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified })
      .from(familyMemberships)
      .innerJoin(users, eq(users.id, familyMemberships.userId))
      .where(and(eq(familyMemberships.familyId, row.familyId), eq(familyMemberships.role, "parent"), ne(users.id, ctx.user.id)));
    for (const parent of otherParents) {
      await notify({
        user: parent,
        category: "family_export",
        dedupeKey: `family_export:${row.id}:u${parent.id}`,
        title: `${ctx.user.name} a exporté les données de la famille`,
        body: `${ctx.user.name} a exporté les données de la famille le ${dateTimeLabel(now)} (archive de tous les dossiers qu'il ou elle peut consulter).`,
        link: "/journal",
        familyId: row.familyId,
        memberId: null,
        now,
      });
    }
    return ready;
  } catch (error) {
    await failExport(row, error, now);
    return null;
  }
}

// Passage du worker (reminders/engine.js) : prépare les demandes en attente
// (si le serveur n'a pas pu le faire), abandonne les demandes trop anciennes,
// efface les archives dont le lien a expiré et les fichiers orphelins.
export async function exportsTick(now = new Date()) {
  const giveUpBefore = new Date(now.getTime() - PENDING_GIVE_UP_MS);
  const staleClaim = new Date(now.getTime() - CLAIM_STALE_MS);

  const abandoned = await db
    .select()
    .from(familyExports)
    .where(and(eq(familyExports.status, "pending"), lt(familyExports.createdAt, giveUpBefore)));
  for (const row of abandoned) await failExport(row, new Error("Préparation abandonnée (délai dépassé)"), now);

  const waiting = await db
    .select({ id: familyExports.id })
    .from(familyExports)
    .where(
      and(
        eq(familyExports.status, "pending"),
        or(isNull(familyExports.claimedAt), lt(familyExports.claimedAt, staleClaim))
      )
    )
    .orderBy(familyExports.id)
    .limit(5);
  for (const { id } of waiting) await prepareFamilyExport(id, { now });

  const expired = await db
    .update(familyExports)
    .set({ status: "expired", filePath: null })
    .where(and(eq(familyExports.status, "ready"), lte(familyExports.expiresAt, now)))
    .returning({ id: familyExports.id });
  // Les fichiers des liens expirés ne sont plus référencés : effacés ci-dessous.

  await removeOrphanFiles();
  return { expired: expired.length };
}

// Fichiers de uploads/exports/ qui ne correspondent à aucune demande en
// cours (préparation ou lien valable) : liens expirés, téléchargements
// interrompus, familles ou comptes supprimés entre-temps.
async function removeOrphanFiles() {
  const names = await fsp.readdir(EXPORT_DIR).catch(() => []);
  if (names.length === 0) return;
  const live = new Set(
    (
      await db
        .select({ filePath: familyExports.filePath })
        .from(familyExports)
        .where(inArray(familyExports.status, ["pending", "ready"]))
    )
      .map((r) => r.filePath)
      .filter(Boolean)
  );
  for (const name of names) {
    if (live.has(name)) continue;
    await removeExportFile(name);
  }
}

// Lien expiré (avant même le passage du worker) ou déjà utilisé.
export function exportLinkState(row, now = new Date()) {
  if (row.status === "ready" && row.expiresAt && row.expiresAt <= now) return "expired";
  return row.status;
}

// Après téléchargement : statut « downloaded » (fait avant l'envoi, pour
// l'usage unique), puis fichier effacé une fois l'envoi terminé.
export async function finishDownload(row) {
  await db.update(familyExports).set({ filePath: null }).where(eq(familyExports.id, row.id));
  await removeExportFile(row.filePath);
}

// Annule les liens encore valables d'un demandeur pour cette famille (une
// nouvelle archive remplace la précédente).
export async function expirePreviousLinks(familyId, userId) {
  const previous = await db
    .update(familyExports)
    .set({ status: "expired", filePath: null })
    .where(and(eq(familyExports.familyId, familyId), eq(familyExports.requestedByUserId, userId), eq(familyExports.status, "ready")))
    .returning({ id: familyExports.id });
  if (previous.length > 0) await removeOrphanFiles();
}

