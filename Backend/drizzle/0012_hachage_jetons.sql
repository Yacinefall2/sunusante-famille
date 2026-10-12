-- Les jetons d'invitation et de vérification d'adresse ne sont plus stockés
-- en clair : seule leur empreinte SHA-256 (hexadécimale) est conservée,
-- comme pour les liens médecin et de réinitialisation. Les liens déjà
-- envoyés restent valables (l'application hache le jeton reçu).
UPDATE "pending_invitations" SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex');
--> statement-breakpoint
UPDATE "email_verification_tokens" SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex');
