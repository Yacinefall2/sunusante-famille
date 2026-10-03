-- Phase C — fiche (coordonnées, médecin traitant, contact d'urgence), documents
-- (auteur, confidentialité), horaires de prise, statut et présence des rendez-vous.

ALTER TABLE "appointments" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "attendance" varchar(20);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "uploaded_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "is_confidential" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "phone" varchar(30);--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "doctor_name" varchar(150);--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "doctor_phone" varchar(30);--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "emergency_contact_name" varchar(150);--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "emergency_contact_relation" varchar(60);--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "emergency_contact_phone" varchar(30);--> statement-breakpoint
ALTER TABLE "treatment_medications" ADD COLUMN "intake_times" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Statuts de rendez-vous existants → nouveau modèle statut + présence :
-- « à venir » → confirmé ; « terminé » → confirmé et honoré ; « annulé » inchangé.
UPDATE "appointments" SET "status" = 'confirmed' WHERE "status" = 'upcoming';
--> statement-breakpoint
UPDATE "appointments" SET "status" = 'confirmed', "attendance" = 'attended' WHERE "status" = 'completed';
