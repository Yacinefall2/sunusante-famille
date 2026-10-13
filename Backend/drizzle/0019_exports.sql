CREATE TABLE "family_exports" (
	"id" serial PRIMARY KEY NOT NULL,
	"family_id" integer NOT NULL,
	"requested_by_user_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"token_hash" varchar(64),
	"file_path" text,
	"size_bytes" bigint,
	"claimed_at" timestamp (3),
	"error" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"ready_at" timestamp (3),
	"expires_at" timestamp (3),
	"downloaded_at" timestamp (3),
	CONSTRAINT "family_exports_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "family_exports" ADD CONSTRAINT "family_exports_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_exports" ADD CONSTRAINT "family_exports_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "family_exports_pending_uq" ON "family_exports" USING btree ("family_id","requested_by_user_id") WHERE "family_exports"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "family_exports_requester_idx" ON "family_exports" USING btree ("requested_by_user_id","created_at" DESC NULLS LAST);