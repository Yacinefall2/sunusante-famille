CREATE TABLE "medication_intakes" (
	"id" serial PRIMARY KEY NOT NULL,
	"medication_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"responded_by_user_id" integer,
	"responded_at" timestamp,
	"reminded_at" timestamp,
	"follow_up_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"category" varchar(40) NOT NULL,
	"in_app" boolean NOT NULL,
	"email" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"family_id" integer,
	"member_id" integer,
	"category" varchar(40) NOT NULL,
	"dedupe_key" varchar(200) NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text,
	"link" varchar(255),
	"intake_id" integer,
	"in_app" boolean DEFAULT true NOT NULL,
	"read_at" timestamp,
	"email_status" varchar(20) DEFAULT 'skipped' NOT NULL,
	"email_attempts" integer DEFAULT 0 NOT NULL,
	"email_next_attempt_at" timestamp,
	"email_last_error" text,
	"email_message_id" varchar(255),
	"email_sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "medication_intakes" ADD CONSTRAINT "medication_intakes_medication_id_treatment_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."treatment_medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_intakes" ADD CONSTRAINT "medication_intakes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_intakes" ADD CONSTRAINT "medication_intakes_responded_by_user_id_users_id_fk" FOREIGN KEY ("responded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_intake_id_medication_intakes_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."medication_intakes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "medication_intakes_medication_time_uq" ON "medication_intakes" USING btree ("medication_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_category_uq" ON "notification_preferences" USING btree ("user_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("dedupe_key");