import fs from "node:fs";
import { Router } from "express";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { families, familyExports, members } from "../db/schema.js";
import { requireFamilyMembership } from "../middleware/auth.js";
import { canReadMember, membershipOf } from "../lib/documentAccess.js";
import { familyIdFromMemberId } from "../lib/familyResolvers.js";
import { archivedErrorOf } from "../lib/archive.js";
import { logActivity } from "../lib/activityLog.js";
import { checkPassword } from "../lib/passwordCheck.js";
import { hashToken } from "../lib/session.js";
import { localDate } from "../lib/time.js";
import { loadMemberRecord, memberPdfFilename, renderMemberRecordPdf, slugify } from "../lib/medicalRecordPdf.js";
import {
  MAX_EXPORTS_PER_DAY,
  expirePreviousLinks,
  exportFilePath,
  exportLinkState,
  finishDownload,
  prepareFamilyExport,
} from "../lib/familyExport.js";
import { parseId } from "../lib/validation.js";

// ── Exports (UC-27 dossier en PDF, UC-09 archive de la famille) ──────────────

// ─── UC-27 : dossier médical en PDF ──────────────────────────────────────────
// GET /api/members/:id/export.pdf — tout compte qui peut LIRE le dossier
// (titulaire, gestionnaire, parent avec accès, lecteur invité dont l'accès
// court encore, adolescent sur sa propre fiche) ; jamais un relais, jamais
// une fiche archivée. Les documents confidentiels n'y figurent que si ce
// compte peut les voir.
export const memberExportRouter = Router();

memberExportRouter.get(
  "/:id/export.pdf",
  requireFamilyMembership((req) => familyIdFromMemberId(req.params.id)),
  async (req, res) => {
    try {
      const memberId = parseId(req.params.id);
      const [fiche] = await db.select().from(members).where(eq(members.id, memberId));
      if (!fiche) return res.status(404).json({ error: "Fiche introuvable" });
      if (fiche.archivedAt) return res.status(403).json({ error: archivedErrorOf(fiche) });
      if (!(await canReadMember(req, memberId))) return res.status(403).json({ error: "Accès refusé à ce dossier" });

      const now = new Date();
      const record = await loadMemberRecord(req, memberId, now);
      const pdf = await renderMemberRecordPdf(record, { exportedBy: req.user.name, exportedAt: now });
      await logActivity({ familyId: req.familyId, actor: req.user, action: "member_exported_pdf", member: fiche, at: now });

      res.set("Cache-Control", "private, no-store");
      res.set("X-Content-Type-Options", "nosniff");
      res.attachment(memberPdfFilename(fiche, now));
      res.type("application/pdf").send(pdf);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// ─── UC-09 : archive ZIP de la famille ───────────────────────────────────────
// Réservé aux parents (A1, A2). Mot de passe exigé, une seule demande en
// préparation à la fois, MAX_EXPORTS_PER_DAY demandes par 24 heures.
export const familyExportRouter = Router();

const familyIdFromParam = (req) => parseId(req.params.id);
const DAY_MS = 24 * 60 * 60 * 1000;

// Ce que l'interface affiche d'une demande (jamais le jeton ni le chemin du fichier).
const presentExport = (row, now = new Date()) => ({
  id: row.id,
  status: exportLinkState(row, now),
  createdAt: row.createdAt,
  readyAt: row.readyAt,
  expiresAt: row.expiresAt,
  downloadedAt: row.downloadedAt,
  sizeBytes: row.sizeBytes,
});

// Demandes récentes de ce parent pour cette famille (5 dernières).
familyExportRouter.get("/:id/exports", requireFamilyMembership(familyIdFromParam, { roles: ["parent"] }), async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(familyExports)
      .where(and(eq(familyExports.familyId, req.familyId), eq(familyExports.requestedByUserId, req.user.id)))
      .orderBy(desc(familyExports.createdAt), desc(familyExports.id))
      .limit(5);
    res.json({ email: req.user.email, maxPerDay: MAX_EXPORTS_PER_DAY, exports: rows.map((r) => presentExport(r)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

familyExportRouter.post("/:id/export", requireFamilyMembership(familyIdFromParam, { roles: ["parent"] }), async (req, res) => {
  try {
    if (req.body?.acknowledged !== true) {
      return res.status(400).json({ error: "Confirmez que vous comprenez que l'archive contient des données de santé confidentielles" });
    }
    const user = await checkPassword(req, res);
    if (!user) return;

    const now = new Date();
    const [inProgress] = await db
      .select({ id: familyExports.id })
      .from(familyExports)
      .where(
        and(
          eq(familyExports.familyId, req.familyId),
          eq(familyExports.requestedByUserId, user.id),
          eq(familyExports.status, "pending")
        )
      );
    if (inProgress) return res.status(409).json({ error: "Une archive est déjà en préparation : vous recevrez le lien par courriel" });

    const recent = await db
      .select({ id: familyExports.id })
      .from(familyExports)
      .where(
        and(
          eq(familyExports.requestedByUserId, user.id),
          gt(familyExports.createdAt, new Date(now.getTime() - DAY_MS)),
          ne(familyExports.status, "failed")
        )
      );
    if (recent.length >= MAX_EXPORTS_PER_DAY) {
      return res.status(429).json({ error: `Limite atteinte : ${MAX_EXPORTS_PER_DAY} exports par 24 heures. Réessayez plus tard.` });
    }

    // Une nouvelle archive remplace la précédente : son lien cesse de fonctionner.
    await expirePreviousLinks(req.familyId, user.id);
    let created;
    try {
      [created] = await db.insert(familyExports).values({ familyId: req.familyId, requestedByUserId: user.id, createdAt: now }).returning();
    } catch (error) {
      // Deux demandes simultanées : l'index unique n'en garde qu'une.
      if (error?.code === "23505" || error?.cause?.code === "23505") {
        return res.status(409).json({ error: "Une archive est déjà en préparation : vous recevrez le lien par courriel" });
      }
      throw error;
    }
    await logActivity({ familyId: req.familyId, actor: req.user, action: "family_export_requested", at: now });

    // Préparation en arrière-plan, tout de suite ; le worker la reprend si
    // le serveur s'arrête entre-temps (lib/familyExport.js exportsTick).
    // Pendant les tests, elle est lancée explicitement.
    if (!process.env.VITEST) {
      setImmediate(() => prepareFamilyExport(created.id).catch((error) => console.error("Export de la famille :", error)));
    }

    res.status(202).json({
      message: `L'archive est en préparation ; vous recevrez un lien par courriel à ${user.email}`,
      export: presentExport(created, now),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ─── Lien reçu par courriel : /export/<jeton> ────────────────────────────────
// Le lien seul ne suffit pas : il faut être connecté avec le compte qui a
// demandé l'archive (et en être toujours parent). Usage unique, 1 heure.
export const exportDownloadRouter = Router();

async function findByToken(req, res) {
  const token = typeof req.params.token === "string" ? req.params.token : "";
  if (!/^[0-9a-f]{64}$/.test(token)) {
    res.status(404).json({ error: "Lien invalide" });
    return null;
  }
  const [row] = await db.select().from(familyExports).where(eq(familyExports.tokenHash, hashToken(token)));
  if (!row) {
    res.status(404).json({ error: "Lien invalide" });
    return null;
  }
  if (row.requestedByUserId !== req.user.id) {
    res.status(403).json({
      error: "Ce lien a été envoyé à un autre compte : connectez-vous avec le compte qui a demandé l'archive",
      code: "WRONG_ACCOUNT",
    });
    return null;
  }
  const membership = await membershipOf(req.user.id, row.familyId);
  if (!membership || membership.role !== "parent") {
    res.status(403).json({ error: "Vous n'êtes plus parent de cette famille : l'archive n'est plus disponible" });
    return null;
  }
  return row;
}

const STATE_ERRORS = {
  downloaded: "Ce lien a déjà servi : l'archive a été téléchargée et effacée du serveur",
  expired: "Ce lien a expiré : demandez une nouvelle archive depuis « Comptes & invitations »",
  failed: "La préparation de cette archive a échoué : demandez-en une nouvelle",
  pending: "L'archive est encore en préparation",
};

// État du lien (sans le consommer), pour la page /export/<jeton>.
exportDownloadRouter.get("/:token", async (req, res) => {
  try {
    const row = await findByToken(req, res);
    if (!row) return;
    const [family] = await db.select({ name: families.name }).from(families).where(eq(families.id, row.familyId));
    res.json({ ...presentExport(row), familyName: family?.name ?? null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

exportDownloadRouter.get("/:token/download", async (req, res) => {
  try {
    const row = await findByToken(req, res);
    if (!row) return;
    const now = new Date();
    const state = exportLinkState(row, now);
    if (state !== "ready") return res.status(state === "pending" ? 409 : 410).json({ error: STATE_ERRORS[state] ?? "Lien invalide" });
    if (!row.filePath || !fs.existsSync(exportFilePath(row.filePath))) {
      return res.status(410).json({ error: "L'archive n'est plus disponible sur le serveur : demandez-en une nouvelle" });
    }

    // Usage unique : le lien est consommé AVANT l'envoi (une seule requête gagne).
    const [consumed] = await db
      .update(familyExports)
      .set({ status: "downloaded", downloadedAt: now })
      .where(and(eq(familyExports.id, row.id), eq(familyExports.status, "ready"), gt(familyExports.expiresAt, now)))
      .returning();
    if (!consumed) return res.status(410).json({ error: STATE_ERRORS.downloaded });
    await logActivity({ familyId: row.familyId, actor: req.user, action: "family_export_downloaded", at: now });

    const [family] = await db.select({ name: families.name }).from(families).where(eq(families.id, row.familyId));
    res.set("Cache-Control", "private, no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.attachment(`sunusante-famille-${slugify(family?.name, "famille").toLowerCase()}-${localDate(now)}.zip`);
    res.type("application/zip");
    if (consumed.sizeBytes) res.set("Content-Length", String(consumed.sizeBytes));

    const stream = fs.createReadStream(exportFilePath(row.filePath));
    let finished = false;
    const cleanUp = () => {
      if (finished) return;
      finished = true;
      finishDownload(row).catch((error) => console.error(error));
    };
    stream.on("error", (error) => {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: "Erreur serveur" });
      else res.destroy();
      cleanUp();
    });
    // Fichier effacé une fois l'envoi terminé (ou interrompu).
    stream.on("close", cleanUp);
    res.on("close", () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});
