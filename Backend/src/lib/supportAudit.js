import { db } from "../db/index.js";
import { supportAudit } from "../db/schema.js";

// ── Journal d'audit du support (INEFFAÇABLE) ─────────────────────────────────
// Chaque action d'un compte support y laisse une ligne : qui, quoi, sur quel
// compte, pour quelle demande, avec quel motif, quand, depuis quelle adresse.
// La base refuse toute modification ou suppression (migration 0021).

export const AUDIT_ACTIONS = {
  login_success: "Connexion réussie",
  login_failed: "Connexion échouée",
  logout: "Déconnexion",
  dashboard_viewed: "Consultation de l'accueil",
  account_searched: "Recherche de comptes",
  account_viewed: "Consultation d'un compte",
  request_viewed: "Consultation d'une demande",
  request_assigned: "Prise en charge d'une demande",
  request_status_changed: "Changement de statut d'une demande",
  request_replied: "Réponse à une demande",
  reset_link_sent: "Envoi d'un lien de réinitialisation du mot de passe",
  login_unlocked: "Déblocage des tentatives de connexion",
  email_changed: "Changement d'adresse courriel",
  account_deleted: "Suppression d'un compte",
  account_suspended: "Suspension d'un compte",
  suspension_lifted: "Levée d'une suspension",
  suspension_lifted_auto: "Levée automatique d'une suspension échue",
  logs_viewed: "Consultation des journaux techniques",
  audit_viewed: "Consultation du journal d'audit",
  support_user_created: "Création d'un compte support (ligne de commande)",
  support_user_deactivated: "Désactivation d'un compte support (ligne de commande)",
  support_totp_reset: "Réinitialisation du double facteur (ligne de commande)",
};

export async function logSupportAction({
  supportUser = null,
  supportEmail = null,
  action,
  target = null,
  requestId = null,
  reason = null,
  details = null,
  ip = null,
  at = new Date(),
}) {
  await db.insert(supportAudit).values({
    occurredAt: at,
    supportUserId: supportUser?.id ?? null,
    supportEmail: supportUser?.email ?? supportEmail ?? null,
    action,
    targetUserId: target?.id ?? null,
    targetEmail: target?.email ?? null,
    requestId,
    reason: reason ? String(reason).slice(0, 2000) : null,
    details,
    ip: ip ? String(ip).slice(0, 64) : null,
  });
}
