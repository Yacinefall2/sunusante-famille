import { describe, it, expect } from "vitest";
import { buildInvitationEmail } from "../src/lib/mailer.js";

describe("Courriel d'invitation (§6.3, §6.4)", () => {
  const base = { familyName: "Ndiaye", role: "adult", token: "abc123", inviterName: "Awa Ndiaye" };

  it("annonce qui invite, la famille, le rôle d'espace et le lien", () => {
    const { subject, html } = buildInvitationEmail(base);
    expect(subject).toBe("Awa Ndiaye vous invite à rejoindre « Ndiaye » sur SunuSanté Famille");
    expect(html).toContain("<strong>Awa Ndiaye</strong> vous invite à rejoindre la famille <strong>Ndiaye</strong>");
    expect(html).toContain("<strong>Membre adulte</strong>");
    expect(html).toContain("/invitations/abc123");
    expect(html).toContain("Accéder à mon compte");
    expect(html).toContain("Ce lien expire dans 30 jours.");
  });

  it.each([
    ["gestionnaire", "gérer le dossier médical de Mamadou Fall"],
    ["lecteur_invite", "consulter le dossier médical de Mamadou Fall"],
    ["relais", "relayer les rendez-vous de Mamadou Fall"],
  ])("annonce le rôle de dossier « %s »", (documentRole, phrase) => {
    const { html } = buildInvitationEmail({ ...base, documentRole, documentMemberName: "Mamadou Fall" });
    expect(html).toContain(`Vous pourrez aussi <strong>${phrase}</strong>`);
  });

  it("sans rôle de dossier, pas de mention de dossier", () => {
    expect(buildInvitationEmail(base).html).not.toContain("Vous pourrez aussi");
  });

  it("échappe les noms saisis par les utilisateurs", () => {
    const { html } = buildInvitationEmail({
      ...base,
      familyName: "<script>alert(1)</script>",
      inviterName: 'Awa "<b>"',
      documentRole: "relais",
      documentMemberName: "<img src=x>",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Awa &quot;&lt;b&gt;&quot;");
  });
});
