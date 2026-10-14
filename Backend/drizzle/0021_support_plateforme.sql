CREATE TABLE "support_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp (3) DEFAULT now() NOT NULL,
	"support_user_id" integer,
	"support_email" varchar(255),
	"action" varchar(60) NOT NULL,
	"target_user_id" integer,
	"target_email" varchar(255),
	"request_id" integer,
	"reason" text,
	"details" jsonb,
	"ip" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "support_request_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"author_type" varchar(10) NOT NULL,
	"support_user_id" integer,
	"user_id" integer,
	"author_name" varchar(150),
	"body" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"reference" varchar(30),
	"type" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'unverified' NOT NULL,
	"user_id" integer,
	"account_email" varchar(255),
	"requester_user_id" integer,
	"contact_email" varchar(255) NOT NULL,
	"new_email" varchar(255),
	"family_id" integer,
	"report_reason" varchar(20),
	"description" text NOT NULL,
	"delete_medical_record" boolean DEFAULT false NOT NULL,
	"verification_token_hash" varchar(64),
	"verification_expires_at" timestamp (3),
	"verified_at" timestamp (3),
	"verified_offline_at" timestamp (3),
	"assigned_to" integer,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	"resolved_at" timestamp (3),
	CONSTRAINT "support_requests_reference_unique" UNIQUE("reference"),
	CONSTRAINT "support_requests_verification_token_hash_unique" UNIQUE("verification_token_hash")
);
--> statement-breakpoint
CREATE TABLE "support_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"support_user_id" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp (3) NOT NULL,
	"revoked_at" timestamp (3),
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "support_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "support_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(150) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"totp_secret_encrypted" text NOT NULL,
	"totp_last_step" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp,
	CONSTRAINT "support_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "technical_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp (3) DEFAULT now() NOT NULL,
	"level" varchar(10) NOT NULL,
	"category" varchar(20) NOT NULL,
	"message" varchar(500) NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_until" timestamp (3);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_by" integer;--> statement-breakpoint
ALTER TABLE "support_request_messages" ADD CONSTRAINT "support_request_messages_request_id_support_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."support_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_request_messages" ADD CONSTRAINT "support_request_messages_support_user_id_support_users_id_fk" FOREIGN KEY ("support_user_id") REFERENCES "public"."support_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_request_messages" ADD CONSTRAINT "support_request_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_assigned_to_support_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."support_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_support_user_id_support_users_id_fk" FOREIGN KEY ("support_user_id") REFERENCES "public"."support_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_audit_occurred_idx" ON "support_audit" USING btree ("occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_request_messages_request_idx" ON "support_request_messages" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "support_requests_status_idx" ON "support_requests" USING btree ("status","type");--> statement-breakpoint
CREATE INDEX "support_requests_user_idx" ON "support_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "support_requests_requester_idx" ON "support_requests" USING btree ("requester_user_id");--> statement-breakpoint
CREATE INDEX "support_sessions_user_idx" ON "support_sessions" USING btree ("support_user_id");--> statement-breakpoint
CREATE INDEX "technical_logs_occurred_idx" ON "technical_logs" USING btree ("occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "technical_logs_category_idx" ON "technical_logs" USING btree ("category","occurred_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_suspended_by_support_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."support_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Journal d'audit du support INEFFAÇABLE (ajouté à la main : drizzle-kit ne
-- génère pas de déclencheur). Aucune modification, aucune suppression : les
-- cibles sont des instantanés sans clé étrangère, rien ne doit jamais y
-- toucher, pas même la suppression d'un compte.
CREATE FUNCTION "support_audit_refuse_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Le journal d''audit du support ne peut être ni modifié ni effacé' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "support_audit_no_update" BEFORE UPDATE ON "support_audit"
  FOR EACH ROW EXECUTE FUNCTION "support_audit_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "support_audit_no_delete" BEFORE DELETE ON "support_audit"
  FOR EACH ROW EXECUTE FUNCTION "support_audit_refuse_change"();
