CREATE TABLE "google_signup_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"google_sub" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(150) NOT NULL,
	"invitation_id" integer,
	"expires_at" timestamp (3) NOT NULL,
	"consumed_at" timestamp (3),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "google_signup_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_sub" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_linked_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "google_signup_tokens" ADD CONSTRAINT "google_signup_tokens_invitation_id_pending_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."pending_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub");