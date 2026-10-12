ALTER TABLE "users" ADD COLUMN "senior_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "senior_mode_set_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "senior_mode_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_senior_mode_set_by_user_id_users_id_fk" FOREIGN KEY ("senior_mode_set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;