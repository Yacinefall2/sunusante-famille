import nodemailer from "nodemailer";
import { logTechnical, maskEmail } from "./technicalLog.js";

// Transport SMTP : MailHog en développement (docker compose --profile dev),
// Gmail possible pour des essais réels. Pour passer à Brevo (ou tout autre
// service), il suffit de changer SMTP_HOST / SMTP_USER / SMTP_PASS (relais
// SMTP smtp-relay.brevo.com) ; les rebonds signalés ensuite par le service
// arrivent sur /api/webhooks/mail (voir routes/mailWebhooks.js).
const smtp = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "localhost",
  port: parseInt(process.env.SMTP_PORT || "1025"),
  secure: process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
});

// Tout envoi passe par ici : chaque courriel envoyé ou échoué est noté au
// journal technique (UC-53) avec le destinataire MASQUÉ (y***@gmail.com),
// jamais l'objet ni le contenu.
const transporter = {
  async sendMail(message) {
    const to = maskEmail(String(message.to ?? ""));
    try {
      const info = await smtp.sendMail(message);
      await logTechnical({ category: "email", message: "Courriel envoyé", metadata: { to } });
      return info;
    } catch (error) {
      await logTechnical({
        level: "error",
        category: "email",
        message: "Échec d'envoi d'un courriel",
        metadata: { to, errorName: error?.name, errorCode: typeof error?.code === "string" ? error.code : undefined },
      });
      throw error;
    }
  },
};

const FROM = process.env.SMTP_FROM || "SunuSanté Famille <no-reply@santefamille.local>";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const ROLE_LABELS = {
  parent: "Parent",
  adult: "Membre adulte",
  dependent: "Personne dépendante",
};

// Gabarit commun aux deux courriels transactionnels — un seul bouton large
// "Accéder à mon compte", expéditeur identifiable, objet explicite, durée de
// validité annoncée en clair (règle transverse §6.4).
function accessButtonTemplate({
  heading,
  bodyHtml,
  link,
  buttonLabel,
  validityLabel,
  footer = "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer ce courriel.",
}) {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #1f2937;">
      <h2 style="color:#0d9488;">${heading}</h2>
      ${bodyHtml}
      <p>
        <a href="${link}" style="background:#0d9488;color:#fff;padding:12px 24px;border-radius:8px;
        text-decoration:none;display:inline-block;font-weight:600;">${buttonLabel}</a>
      </p>
      <p style="color:#9ca3af;font-size:12px;">
        ${validityLabel} ${footer}
      </p>
    </div>
  `;
}

// Ce que l'invitation permet sur un dossier précis (rôle Axe 2), formulé pour
// l'invité : le courriel annonce explicitement à quoi il est convié (§6.3).
const DOCUMENT_ROLE_PHRASES = {
  gestionnaire: "gérer le dossier médical de",
  lecteur_invite: "consulter le dossier médical de",
  relais: "relayer les rendez-vous de",
};

// Les noms (famille, personnes) sont saisis par les utilisateurs : on les
// échappe avant de les insérer dans le HTML du courriel.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Contenu du courriel d'invitation (objet + HTML), séparé de l'envoi pour
// pouvoir être vérifié par les tests.
const DOCUMENT_ROLE_DURATIONS = { "7j": "7 jours", "30j": "30 jours", "3m": "3 mois", "1a": "1 an" };

export function buildInvitationEmail({ familyName, role, token, inviterName, documentMemberName, documentRole, documentRoleDuration }) {
  const link = `${FRONTEND_URL}/invitations/${token}`;
  const roleLabel = ROLE_LABELS[role] || role;
  const inviter = inviterName ? escapeHtml(inviterName) : null;
  const family = escapeHtml(familyName);
  const phrase = DOCUMENT_ROLE_PHRASES[documentRole];

  const intro = inviter
    ? `<strong>${inviter}</strong> vous invite à rejoindre la famille <strong>${family}</strong> en tant que <strong>${roleLabel}</strong>.`
    : `Vous avez été invité(e) à rejoindre la famille <strong>${family}</strong> en tant que <strong>${roleLabel}</strong>.`;
  const documentLine =
    phrase && documentMemberName
      ? `<p>Vous pourrez aussi <strong>${phrase} ${escapeHtml(documentMemberName)}</strong>` +
        (documentRole === "lecteur_invite" && DOCUMENT_ROLE_DURATIONS[documentRoleDuration]
          ? `, pendant ${DOCUMENT_ROLE_DURATIONS[documentRoleDuration]} à compter de votre arrivée (consultation seule).</p>`
          : ".</p>")
      : "";

  return {
    subject: inviterName
      ? `${inviterName} vous invite à rejoindre « ${familyName} » sur SunuSanté Famille`
      : `Invitation à rejoindre « ${familyName} » sur SunuSanté Famille`,
    html: accessButtonTemplate({
      heading: "Vous êtes invité(e) sur SunuSanté Famille",
      bodyHtml: `<p>${intro}</p>${documentLine}`,
      link,
      buttonLabel: "Accéder à mon compte",
      validityLabel: "Ce lien expire dans 30 jours.",
    }),
  };
}

export async function sendInvitationEmail({ to, ...details }) {
  await transporter.sendMail({ from: FROM, to, ...buildInvitationEmail(details) });
}

// Courriel de vérification d'adresse à l'inscription (UC-61/64) — seul canal
// possible pour cet événement (règle transverse §7), sans exception.
export async function sendVerificationEmail({ to, name, token }) {
  const link = `${FRONTEND_URL}/verifier-email/${token}`;

  await transporter.sendMail({
    from: FROM,
    to,
    subject: "Confirmez votre adresse pour activer votre compte SunuSanté Famille",
    html: accessButtonTemplate({
      heading: `Bienvenue sur SunuSanté Famille, ${escapeHtml(name)}`,
      bodyHtml: `<p>Pour activer votre compte et accéder à votre espace familial, confirmez que cette
        adresse courriel vous appartient bien en cliquant sur le bouton ci-dessous.</p>`,
      link,
      buttonLabel: "Accéder à mon compte",
      validityLabel: "Ce lien expire dans 24 heures.",
    }),
  });
}

// ── Connexion avec Google ────────────────────────────────────────────────────

// Avis de sécurité : la connexion Google vient d'être ajoutée au compte (liaison
// automatique à la première connexion Google, ou depuis « Mon compte »).
export function buildGoogleLinkedEmail({ name }) {
  return {
    subject: "Connexion Google ajoutée à votre compte SunuSanté Famille",
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name)}`,
      bodyHtml: `<p>Vous pouvez désormais vous connecter à SunuSanté Famille avec le bouton « Continuer avec Google »,
        en plus de votre mot de passe habituel s'il existe.</p>
        <p><strong>Si ce n'est pas vous</strong>, contactez le support sans attendre avec le bouton ci-dessous.</p>`,
      link: `${FRONTEND_URL}/support/acces`,
      buttonLabel: "Ce n'est pas moi : contacter le support",
      validityLabel: "Si c'est bien vous, aucune action n'est nécessaire.",
      footer: "",
    }),
  };
}

export async function sendGoogleLinkedEmail({ to, name }) {
  // Un avis non remis ne doit pas faire échouer la connexion elle-même.
  try {
    await transporter.sendMail({ from: FROM, to, ...buildGoogleLinkedEmail({ name }) });
  } catch (error) {
    console.error(error);
  }
}

// Bienvenue après une inscription avec Google : l'adresse est déjà vérifiée
// par Google, donc AUCUN lien d'activation — un simple lien vers l'application.
export function buildGoogleWelcomeEmail({ name }) {
  return {
    subject: "Bienvenue sur SunuSanté Famille",
    html: accessButtonTemplate({
      heading: `Bienvenue sur SunuSanté Famille, ${escapeHtml(name)}`,
      bodyHtml: `<p>Votre compte est créé et prêt à l'emploi. Pour vous connecter, utilisez le bouton
        « Continuer avec Google ». Vous pouvez aussi définir un mot de passe depuis « Mon compte ».</p>
        <p>Prochaine étape : créez votre espace familial, ou complétez votre fiche si vous avez rejoint une famille.</p>`,
      link: `${FRONTEND_URL}/dashboard`,
      buttonLabel: "Ouvrir SunuSanté Famille",
      validityLabel: "",
      footer: "Si vous n'êtes pas à l'origine de cette inscription, contactez le support depuis la page de connexion (« Je n'arrive plus à accéder à mon compte »).",
    }),
  };
}

export async function sendGoogleWelcomeEmail({ to, name }) {
  try {
    await transporter.sendMail({ from: FROM, to, ...buildGoogleWelcomeEmail({ name }) });
  } catch (error) {
    console.error(error);
  }
}

// Courriel « Mot de passe oublié » : lien de réinitialisation valable 1 heure.
export function buildPasswordResetEmail({ name, token }) {
  return {
    subject: "Réinitialisez votre mot de passe SunuSanté Famille",
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name)}`,
      bodyHtml: `<p>Vous avez demandé à changer le mot de passe de votre compte SunuSanté Famille.
        Cliquez sur le bouton ci-dessous pour en choisir un nouveau.</p>`,
      link: `${FRONTEND_URL}/reinitialiser-mot-de-passe/${token}`,
      buttonLabel: "Choisir un nouveau mot de passe",
      validityLabel: "Ce lien expire dans 1 heure et ne sert qu'une fois.",
      footer: "Si vous n'êtes pas à l'origine de cette demande, ignorez ce courriel : votre mot de passe reste inchangé.",
    }),
  };
}

export async function sendPasswordResetEmail({ to, ...details }) {
  await transporter.sendMail({ from: FROM, to, ...buildPasswordResetEmail(details) });
}

// Inscription avec une adresse déjà enregistrée : la personne est prévenue
// par courriel plutôt qu'à l'écran (qui ne doit pas révéler les inscrits).
export function buildAccountExistsEmail({ name }) {
  return {
    subject: "Vous avez déjà un compte SunuSanté Famille",
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name)}`,
      bodyHtml: `<p>Quelqu'un (vous, sans doute) a voulu créer un compte avec cette adresse, mais elle est déjà
        enregistrée. Connectez-vous avec votre mot de passe habituel, ou choisissez-en un nouveau si vous l'avez oublié.
        Si vous vous êtes inscrit avec Google, utilisez le bouton « Continuer avec Google ».</p>`,
      link: `${FRONTEND_URL}/mot-de-passe-oublie`,
      buttonLabel: "Mot de passe oublié",
      validityLabel: "",
      footer: "Si vous n'êtes pas à l'origine de cette demande, ignorez ce courriel : votre compte n'a pas changé.",
    }),
  };
}

export async function sendAccountExistsEmail({ to, name }) {
  await transporter.sendMail({ from: FROM, to, ...buildAccountExistsEmail({ name }) });
}

// Alerte de sécurité : le mot de passe vient d'être changé. Permet de
// repérer un changement qu'on n'a pas fait soi-même.
export function buildPasswordChangedAlert({ name }) {
  return {
    subject: "Votre mot de passe SunuSanté Famille a été modifié",
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name)}`,
      bodyHtml: `<p>Le mot de passe de votre compte SunuSanté Famille vient d'être modifié, et toutes vos sessions
        ouvertes ont été fermées.</p>
        <p><strong>Si ce n'est pas vous</strong>, choisissez immédiatement un nouveau mot de passe avec le bouton
        ci-dessous : quelqu'un d'autre connaît peut-être l'ancien.</p>`,
      link: `${FRONTEND_URL}/mot-de-passe-oublie`,
      buttonLabel: "Ce n'est pas moi : sécuriser mon compte",
      validityLabel: "Si c'est bien vous, aucune action n'est nécessaire.",
      footer: "",
    }),
  };
}

export async function sendPasswordChangedAlert({ email, name }) {
  // Une alerte non remise ne doit pas faire échouer le changement lui-même.
  try {
    await transporter.sendMail({ from: FROM, to: email, ...buildPasswordChangedAlert({ name }) });
  } catch (error) {
    console.error(error);
  }
}

// Changement d'adresse : le lien part vers la NOUVELLE adresse, qui ne
// remplace l'ancienne qu'une fois ce lien suivi.
export function buildEmailChangeEmail({ name, token }) {
  return {
    subject: "Confirmez votre nouvelle adresse SunuSanté Famille",
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name)}`,
      bodyHtml: `<p>Vous avez demandé à utiliser cette adresse pour votre compte SunuSanté Famille. Confirmez-la
        avec le bouton ci-dessous : elle remplacera alors l'ancienne pour la connexion et les courriels.</p>`,
      link: `${FRONTEND_URL}/confirmer-email/${token}`,
      buttonLabel: "Confirmer cette adresse",
      validityLabel: "Ce lien expire dans 24 heures et ne sert qu'une fois.",
    }),
  };
}

export async function sendEmailChangeEmail({ to, ...details }) {
  await transporter.sendMail({ from: FROM, to, ...buildEmailChangeEmail(details) });
}

// Avis envoyé à l'ANCIENNE adresse quand le changement est demandé.
export async function sendEmailChangeNotice({ to, name, newEmail }) {
  try {
    await transporter.sendMail({
      from: FROM,
      to,
      subject: "Demande de changement d'adresse sur SunuSanté Famille",
      html: accessButtonTemplate({
        heading: `Bonjour ${escapeHtml(name)}`,
        bodyHtml: `<p>Un changement d'adresse courriel a été demandé pour votre compte, vers
          <strong>${escapeHtml(newEmail)}</strong>. Il ne prendra effet que si ce lien de confirmation est suivi.</p>
          <p><strong>Si ce n'est pas vous</strong>, changez votre mot de passe dès maintenant.</p>`,
        link: `${FRONTEND_URL}/mot-de-passe-oublie`,
        buttonLabel: "Ce n'est pas moi : sécuriser mon compte",
        validityLabel: "Si c'est bien vous, aucune action n'est nécessaire.",
        footer: "",
      }),
    });
  } catch (error) {
    console.error(error);
  }
}

// Courriel au médecin avec qui un dossier est partagé : le lien n'est transmis
// que par ce canal, jamais affiché à la famille.
export function buildDoctorShareEmail({ link, memberName, senderName, expiresAtLabel }) {
  const member = escapeHtml(memberName);
  const sender = senderName ? escapeHtml(senderName) : null;
  return {
    subject: `Dossier médical de ${memberName} partagé avec vous — SunuSanté Famille`,
    html: accessButtonTemplate({
      heading: "Un dossier médical est partagé avec vous",
      bodyHtml: `<p>${sender ? `<strong>${sender}</strong> vous donne` : "Vous avez reçu"} accès, en lecture seule, au
        dossier médical de <strong>${member}</strong>.</p>
        <p>Ce lien ne s'ouvre qu'une seule fois, sur un seul appareil : ouvrez-le sur celui où vous consulterez le
        dossier. Il ne fonctionnera plus ensuite sur un autre appareil.</p>`,
      link,
      buttonLabel: "Consulter le dossier",
      validityLabel: `Ce lien expire le ${escapeHtml(expiresAtLabel)}.`,
      footer: "Si vous n'attendiez pas ce courriel, ne l'ouvrez pas et supprimez-le.",
    }),
  };
}

export async function sendDoctorShareEmail({ to, ...details }) {
  await transporter.sendMail({ from: FROM, to, ...buildDoctorShareEmail(details) });
}

// Archive des données de la famille prête (UC-09) : lien à usage unique,
// valable 1 heure, qui exige en plus d'être connecté avec le compte du
// demandeur. Objet neutre : aucune donnée de santé.
export function buildFamilyExportEmail({ name, familyName, token, expiresAtLabel }) {
  return {
    subject: "Votre archive des données de la famille est prête — SunuSanté Famille",
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name)}`,
      bodyHtml: `<p>L'archive des données de la famille <strong>${escapeHtml(familyName)}</strong> que vous avez demandée
        est prête. Pour la télécharger, ouvrez le lien ci-dessous : vous devrez être connecté(e) à votre compte
        SunuSanté Famille.</p>
        <p>Elle contient des <strong>données de santé confidentielles</strong> : enregistrez-la dans un endroit sûr et
        ne la transmettez qu'à des personnes de confiance.</p>`,
      link: `${FRONTEND_URL}/export/${token}`,
      buttonLabel: "Télécharger l'archive",
      validityLabel: `Ce lien ne sert qu'une fois et expire le ${escapeHtml(expiresAtLabel)}.`,
      footer: "Si vous n'avez pas demandé cet export, changez votre mot de passe dès maintenant.",
    }),
  };
}

export async function sendFamilyExportEmail({ to, ...details }) {
  await transporter.sendMail({ from: FROM, to, ...buildFamilyExportEmail(details) });
}

// Objet des courriels de notification : NEUTRE, sans aucune donnée de santé.
// L'objet s'affiche sur l'écran verrouillé du téléphone, dans les aperçus et
// les listes de messages : le nom d'un médicament, d'un vaccin ou le motif
// d'un rendez-vous n'y a pas sa place. Le détail reste dans le corps.
const NOTIFICATION_SUBJECTS = {
  appointment_reminder: "Rappel de rendez-vous — SunuSanté Famille",
  medication_intake: "Rappel de prise — SunuSanté Famille",
  vaccine_reminder: "Rappel de vaccination — SunuSanté Famille",
  doctor_share: "Partage de dossier — SunuSanté Famille",
  emergency_view: "Fiche d'urgence consultée — SunuSanté Famille",
  family_export: "Export des données de la famille — SunuSanté Famille",
};
export const DEFAULT_NOTIFICATION_SUBJECT = "Rappel SunuSanté Famille";

export function notificationSubject(category) {
  return NOTIFICATION_SUBJECTS[category] ?? DEFAULT_NOTIFICATION_SUBJECT;
}

// Contenu d'un courriel de notification (objet + HTML), séparé de l'envoi
// pour pouvoir être vérifié par les tests. Le paramètre `subject` fourni par
// l'appelant (qui peut contenir le titre de la notification) est ignoré.
export function buildNotificationEmail({ category, heading, lines = [], link, buttonLabel = "Voir dans SunuSanté Famille" }) {
  return {
    subject: notificationSubject(category),
    html: accessButtonTemplate({
      heading: escapeHtml(heading),
      bodyHtml: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(""),
      link: `${FRONTEND_URL}${link ?? "/dashboard"}`,
      buttonLabel,
      validityLabel: "Vous pouvez choisir vos canaux de notification dans l'application.",
      footer: "",
    }),
  };
}

// Courriel d'une notification (rappel de rendez-vous, de prise, de vaccin).
// Renvoie l'identifiant du message, qui permet de rattacher un rebond signalé
// plus tard par le service d'envoi à cette notification.
export async function sendNotificationEmail({ to, ...details }) {
  const info = await transporter.sendMail({ from: FROM, to, ...buildNotificationEmail(details) });
  return info.messageId ?? null;
}

// ── Support de la plateforme (acteur A5, UC-50 à 52) ─────────────────────────
// Aucun de ces courriels ne contient de donnée médicale. Réponse possible au
// support : adresse SUPPORT_CONTACT_EMAIL (facultative) en « Répondre à ».
const SUPPORT_REPLY_TO = process.env.SUPPORT_CONTACT_EMAIL?.trim() || undefined;
const supportMail = (message) => transporter.sendMail({ from: FROM, replyTo: SUPPORT_REPLY_TO, ...message });

export const SUPPORT_TYPE_LABELS = {
  recovery: "récupération de l'accès au compte",
  data_deletion: "suppression de vos données",
  report: "signalement d'un compte",
  other: "question au support",
};
export const SUPPORT_STATUS_LABELS = {
  unverified: "en attente de confirmation",
  open: "ouverte",
  in_progress: "en cours de traitement",
  resolved: "traitée",
  rejected: "refusée",
};

// Lien de confirmation d'identité (24 h, usage unique), envoyé à l'adresse
// DU COMPTE : la demande n'est traitée qu'une fois ce lien suivi.
export function buildSupportConfirmationEmail({ name, token, reference, type }) {
  return {
    subject: `Confirmez votre demande ${reference} — SunuSanté Famille`,
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name)}`,
      bodyHtml: `<p>Une demande de <strong>${SUPPORT_TYPE_LABELS[type] ?? "support"}</strong> (référence
        <strong>${escapeHtml(reference)}</strong>) a été adressée au support de SunuSanté Famille pour ce compte.</p>
        <p>Pour confirmer qu'elle vient bien de vous, cliquez sur le bouton ci-dessous. Le support ne la traitera
        qu'après cette confirmation.</p>`,
      link: `${FRONTEND_URL}/support/confirmer/${token}`,
      buttonLabel: "Confirmer ma demande",
      validityLabel: "Ce lien expire dans 24 heures et ne sert qu'une fois.",
      footer: "Si vous n'êtes pas à l'origine de cette demande, ignorez ce courriel : rien ne sera fait sur votre compte.",
    }),
  };
}

export async function sendSupportConfirmationEmail({ to, ...details }) {
  await supportMail({ to, ...buildSupportConfirmationEmail(details) });
}

// Changement de statut d'une demande, ou réponse du support (texte du support).
export function buildSupportUpdateEmail({ name, reference, status, message }) {
  const statusLine = status
    ? `<p>Votre demande <strong>${escapeHtml(reference)}</strong> est désormais <strong>${SUPPORT_STATUS_LABELS[status] ?? status}</strong>.</p>`
    : `<p>Le support a répondu à votre demande <strong>${escapeHtml(reference)}</strong> :</p>`;
  const body = message
    ? `<blockquote style="border-left:3px solid #0d9488;margin:0;padding:8px 12px;color:#374151;white-space:pre-wrap;">${escapeHtml(message)}</blockquote>`
    : "";
  return {
    subject: `Votre demande ${reference} — Support SunuSanté Famille`,
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name ?? "")}`,
      bodyHtml: `${statusLine}${body}<p>Retrouvez vos demandes et répondez au support dans « Mon compte », rubrique « Mes demandes ».</p>`,
      link: `${FRONTEND_URL}/support`,
      buttonLabel: "Voir mes demandes",
      validityLabel: "N'indiquez jamais d'information médicale dans vos échanges avec le support.",
      footer: "",
    }),
  };
}

export async function sendSupportUpdateEmail({ to, ...details }) {
  await supportMail({ to, ...buildSupportUpdateEmail(details) });
}

// Adresse du compte changée par le support (UC-50) : avis à l'ANCIENNE adresse.
export function buildSupportEmailChangedNotice({ name, newEmailMasked }) {
  return {
    subject: "L'adresse de votre compte SunuSanté Famille a été changée",
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name)}`,
      bodyHtml: `<p>À la suite d'une demande de récupération de compte, le support de SunuSanté Famille a remplacé
        l'adresse de votre compte par <strong>${escapeHtml(newEmailMasked)}</strong>, après avoir vérifié l'identité de
        la personne. Toutes les sessions ouvertes ont été fermées.</p>
        <p><strong>Si vous n'êtes pas à l'origine de cette demande</strong>, contactez immédiatement le support.</p>`,
      link: `${FRONTEND_URL}/support/acces`,
      buttonLabel: "Contacter le support",
      validityLabel: "",
      footer: "",
    }),
  };
}

export async function sendSupportEmailChangedNotice({ to, ...details }) {
  await supportMail({ to, ...buildSupportEmailChangedNotice(details) });
}

// Suspension (UC-52) : à la personne, avec le motif, la durée et le recours.
export function buildAccountSuspendedEmail({ name, reason, endLabel }) {
  return {
    subject: "Votre compte SunuSanté Famille est suspendu",
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name)}`,
      bodyHtml: `<p>À la suite d'un signalement, le support de SunuSanté Famille a <strong>suspendu votre compte
        ${escapeHtml(endLabel)}</strong>.</p>
        <p><strong>Motif :</strong> ${escapeHtml(reason)}</p>
        <p>Pendant la suspension, vous ne pouvez plus vous connecter et vous ne recevez plus de notifications. Vos
        données, votre fiche et vos rôles dans votre famille restent intacts.</p>
        <p><strong>Pour contester</strong> : répondez à ce courriel, ou contactez le support avec le bouton ci-dessous.</p>`,
      link: `${FRONTEND_URL}/support/acces`,
      buttonLabel: "Contacter le support",
      validityLabel: "",
      footer: "",
    }),
  };
}

export async function sendAccountSuspendedEmail({ to, ...details }) {
  await supportMail({ to, ...buildAccountSuspendedEmail(details) });
}

export async function sendAccountReinstatedEmail({ to, name }) {
  await supportMail({
    to,
    subject: "Votre compte SunuSanté Famille est de nouveau actif",
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name)}`,
      bodyHtml: `<p>La suspension de votre compte a été levée : vous pouvez de nouveau vous connecter et recevoir vos
        notifications. Pensez à réactiver les notifications sur vos appareils (« Mon compte »).</p>`,
      link: `${FRONTEND_URL}/login`,
      buttonLabel: "Me connecter",
      validityLabel: "",
      footer: "",
    }),
  });
}

// À l'Administrateur familial (A1) : un compte de sa famille est suspendu —
// SANS le motif détaillé, qui ne regarde que la personne et le support.
export function buildFamilyAccountSuspendedEmail({ name, memberName, familyName }) {
  return {
    subject: "Un compte de votre famille est suspendu — SunuSanté Famille",
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name)}`,
      bodyHtml: `<p>Le compte de <strong>${escapeHtml(memberName)}</strong>, dans la famille
        <strong>${escapeHtml(familyName)}</strong>, a été suspendu par le support de SunuSanté Famille.</p>
        <p>Ses données et sa fiche restent intactes. Les rappels de santé de ses proches continuent d'arriver à leurs
        autres gestionnaires.</p>`,
      link: `${FRONTEND_URL}/famille`,
      buttonLabel: "Voir les comptes de la famille",
      validityLabel: "",
      footer: "",
    }),
  };
}

export async function sendFamilyAccountSuspendedEmail({ to, ...details }) {
  await supportMail({ to, ...buildFamilyAccountSuspendedEmail(details) });
}

export async function sendFamilyAccountReinstatedEmail({ to, name, memberName, familyName }) {
  await supportMail({
    to,
    subject: "Un compte de votre famille est de nouveau actif — SunuSanté Famille",
    html: accessButtonTemplate({
      heading: `Bonjour ${escapeHtml(name)}`,
      bodyHtml: `<p>La suspension du compte de <strong>${escapeHtml(memberName)}</strong>, dans la famille
        <strong>${escapeHtml(familyName)}</strong>, a été levée.</p>`,
      link: `${FRONTEND_URL}/famille`,
      buttonLabel: "Voir les comptes de la famille",
      validityLabel: "",
      footer: "",
    }),
  });
}
