import nodemailer from "nodemailer";

// Transport SMTP : Gmail en développement. Pour passer à Brevo (ou tout autre
// service), il suffit de changer SMTP_HOST / SMTP_USER / SMTP_PASS (relais
// SMTP smtp-relay.brevo.com) ; les rebonds signalés ensuite par le service
// arrivent sur /api/webhooks/mail (voir routes/mailWebhooks.js).
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "localhost",
  port: parseInt(process.env.SMTP_PORT || "1025"),
  secure: process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
});

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
export function buildInvitationEmail({ familyName, role, token, inviterName, documentMemberName, documentRole }) {
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
      ? `<p>Vous pourrez aussi <strong>${phrase} ${escapeHtml(documentMemberName)}</strong>.</p>`
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

// Courriel d'une notification (rappel de rendez-vous, de prise, de vaccin).
// Renvoie l'identifiant du message, qui permet de rattacher un rebond signalé
// plus tard par le service d'envoi à cette notification.
export async function sendNotificationEmail({ to, subject, heading, lines = [], link, buttonLabel = "Voir dans SunuSanté Famille" }) {
  const info = await transporter.sendMail({
    from: FROM,
    to,
    subject,
    html: accessButtonTemplate({
      heading: escapeHtml(heading),
      bodyHtml: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(""),
      link: `${FRONTEND_URL}${link ?? "/dashboard"}`,
      buttonLabel,
      validityLabel: "Vous pouvez choisir vos canaux de notification dans l'application.",
      footer: "",
    }),
  });
  return info.messageId ?? null;
}
