CREATE TABLE "doctor_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"family_id" integer NOT NULL,
	"created_by_user_id" integer,
	"token_hash" varchar(64) NOT NULL,
	"include_essentials" boolean DEFAULT true NOT NULL,
	"include_treatments" boolean DEFAULT false NOT NULL,
	"include_vaccinations" boolean DEFAULT false NOT NULL,
	"document_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"consumed_at" timestamp,
	"session_hash" varchar(64),
	"last_viewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_shares_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "emergency_card_views" (
	"id" serial PRIMARY KEY NOT NULL,
	"card_id" integer NOT NULL,
	"viewed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emergency_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"token" varchar(64) NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"show_age" boolean DEFAULT false NOT NULL,
	"show_blood_type" boolean DEFAULT false NOT NULL,
	"show_allergies" boolean DEFAULT false NOT NULL,
	"show_treatments" boolean DEFAULT false NOT NULL,
	"show_emergency_contact" boolean DEFAULT false NOT NULL,
	"show_doctor" boolean DEFAULT false NOT NULL,
	"extra_info" text,
	"updated_by_user_id" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "emergency_cards_member_id_unique" UNIQUE("member_id"),
	CONSTRAINT "emergency_cards_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "doctor_shares" ADD CONSTRAINT "doctor_shares_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_shares" ADD CONSTRAINT "doctor_shares_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_shares" ADD CONSTRAINT "doctor_shares_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_card_views" ADD CONSTRAINT "emergency_card_views_card_id_emergency_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."emergency_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_cards" ADD CONSTRAINT "emergency_cards_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_cards" ADD CONSTRAINT "emergency_cards_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;