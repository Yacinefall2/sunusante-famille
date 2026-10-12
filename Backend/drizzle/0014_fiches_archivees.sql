ALTER TABLE "members" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "archived_user_id" integer;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_archived_user_id_users_id_fk" FOREIGN KEY ("archived_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;