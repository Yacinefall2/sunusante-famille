CREATE TABLE "family_reminder_settings" (
	"family_id" integer PRIMARY KEY NOT NULL,
	"relay_first_days" integer DEFAULT 3 NOT NULL,
	"follow_up_days_before" integer DEFAULT 1 NOT NULL,
	"escalation_delay_hours" integer DEFAULT 3 NOT NULL,
	"attendance_prompt" varchar(20) DEFAULT 'same_evening' NOT NULL,
	"updated_by_user_id" integer,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"family_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"from_user_id" integer NOT NULL,
	"to_user_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) NOT NULL,
	"responded_at" timestamp (3)
);
--> statement-breakpoint
ALTER TABLE "document_roles" ADD COLUMN "expires_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "pending_invitations" ADD COLUMN "document_role_duration" varchar(5);--> statement-breakpoint
ALTER TABLE "family_reminder_settings" ADD CONSTRAINT "family_reminder_settings_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_reminder_settings" ADD CONSTRAINT "family_reminder_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_transfers" ADD CONSTRAINT "role_transfers_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_transfers" ADD CONSTRAINT "role_transfers_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_transfers" ADD CONSTRAINT "role_transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_transfers" ADD CONSTRAINT "role_transfers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "role_transfers_pending_member_uq" ON "role_transfers" USING btree ("member_id") WHERE "role_transfers"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "role_transfers_to_user_idx" ON "role_transfers" USING btree ("to_user_id","status");--> statement-breakpoint
-- Lecteurs invités déjà en place (ajouté à la main) : leur accès devient à
-- durée limitée, 30 jours à compter de cette migration (R4).
UPDATE "document_roles" SET "expires_at" = now() + interval '30 days' WHERE "role" = 'lecteur_invite' AND "expires_at" IS NULL;
--> statement-breakpoint
-- Invitations en attente proposant un rôle de lecteur invité : durée par défaut de 30 jours.
UPDATE "pending_invitations" SET "document_role_duration" = '30j' WHERE "document_role" = 'lecteur_invite' AND "document_role_duration" IS NULL AND "accepted_at" IS NULL;
