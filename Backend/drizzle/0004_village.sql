CREATE TABLE "relay_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"type" varchar(30) NOT NULL,
	"user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"appointment_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"family_id" integer NOT NULL,
	"appointment_date" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"follow_up_at" timestamp,
	"escalated_at" timestamp,
	"notified_at" timestamp,
	"notified_by_user_id" integer,
	"attendance_prompt_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "relay_events" ADD CONSTRAINT "relay_events_task_id_relay_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."relay_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_events" ADD CONSTRAINT "relay_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_tasks" ADD CONSTRAINT "relay_tasks_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_tasks" ADD CONSTRAINT "relay_tasks_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_tasks" ADD CONSTRAINT "relay_tasks_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_tasks" ADD CONSTRAINT "relay_tasks_notified_by_user_id_users_id_fk" FOREIGN KEY ("notified_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relay_tasks_appointment_date_uq" ON "relay_tasks" USING btree ("appointment_id","appointment_date");