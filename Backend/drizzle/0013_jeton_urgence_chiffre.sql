-- Fiche d'urgence : le jeton du QR code n'est plus stocké en clair. Son
-- empreinte SHA-256 (hexadécimale, comme lib/sharing.js hashToken) sert à la
-- recherche publique ; une copie chiffrée (AES-256-GCM) permet au titulaire
-- de réafficher son QR code. Le chiffrement ne peut pas se faire en SQL :
-- l'application convertit les anciens jetons (chiffre, puis vide la colonne
-- token) au démarrage et à la première utilisation. Les QR codes déjà
-- imprimés restent valables (même jeton, retrouvé par son empreinte).
ALTER TABLE "emergency_cards" ALTER COLUMN "token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "emergency_cards" ADD COLUMN "token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "emergency_cards" ADD COLUMN "token_encrypted" text;--> statement-breakpoint
UPDATE "emergency_cards" SET "token_hash" = encode(sha256(convert_to("token", 'UTF8')), 'hex');--> statement-breakpoint
ALTER TABLE "emergency_cards" ALTER COLUMN "token_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "emergency_cards" ADD CONSTRAINT "emergency_cards_token_hash_unique" UNIQUE("token_hash");
