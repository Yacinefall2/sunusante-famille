import nodemailer from "nodemailer";

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
function accessButtonTemplate({ heading, bodyHtml, link, buttonLabel, validityLabel }) {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #1f2937;">
      <h2 style="color:#0d9488;">${heading}</h2>
      ${bodyHtml}
      <p>
        <a href="${link}" style="background:#0d9488;color:#fff;padding:12px 24px;border-radius:8px;
        text-decoration:none;display:inline-block;font-weight:600;">${buttonLabel}</a>
      </p>
      <p style="color:#9ca3af;font-size:12px;">
        ${validityLabel} Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer ce courriel.
      </p>
    </div>
  `;
}

export async function sendInvitationEmail({ to, familyName, role, token }) {
  const link = `${FRONTEND_URL}/invitations/${token}`;
  const roleLabel = ROLE_LABELS[role] || role;

  await transporter.sendMail({
    from: FROM,
    to,
    subject: `Invitation à rejoindre la famille "${familyName}" sur SunuSanté Famille`,
    html: accessButtonTemplate({
      heading: "Vous êtes invité(e) sur SunuSanté Famille",
      bodyHtml: `<p>Vous avez été invité(e) à rejoindre la famille <strong>${familyName}</strong> en tant que
        <strong>${roleLabel}</strong>.</p>`,
      link,
      buttonLabel: "Accéder à mon compte",
      validityLabel: "Ce lien expire dans 30 jours.",
    }),
  });
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
      heading: `Bienvenue sur SunuSanté Famille, ${name}`,
      bodyHtml: `<p>Pour activer votre compte et accéder à votre espace familial, confirmez que cette
        adresse courriel vous appartient bien en cliquant sur le bouton ci-dessous.</p>`,
      link,
      buttonLabel: "Accéder à mon compte",
      validityLabel: "Ce lien expire dans 24 heures.",
    }),
  });
}