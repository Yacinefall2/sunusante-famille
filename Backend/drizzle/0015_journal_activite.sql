CREATE TABLE "activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"family_id" integer NOT NULL,
	"occurred_at" timestamp (3) DEFAULT now() NOT NULL,
	"actor_user_id" integer,
	"actor_name" varchar(150),
	"action" varchar(60) NOT NULL,
	"member_id" integer,
	"member_name" varchar(210),
	"target_user_id" integer,
	"target_name" varchar(150),
	"details" jsonb
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_family_occurred_idx" ON "activity_log" USING btree ("family_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_log_member_idx" ON "activity_log" USING btree ("member_id");--> statement-breakpoint
-- Journal ineffaçable (ajouté à la main : drizzle-kit ne génère pas de
-- déclencheur). Toute modification d'une entrée est refusée, sauf celle que
-- fait PostgreSQL lui-même à la suppression d'un compte (ON DELETE SET NULL
-- sur actor_user_id / target_user_id) : l'identifiant passe à NULL, tout le
-- reste — dont le nom conservé — doit rester identique.
CREATE FUNCTION "activity_log_refuse_update"() RETURNS trigger AS $$
BEGIN
  IF (NEW.id, NEW.family_id, NEW.occurred_at, NEW.actor_name, NEW.action, NEW.member_id, NEW.member_name, NEW.target_name, NEW.details)
       IS NOT DISTINCT FROM
     (OLD.id, OLD.family_id, OLD.occurred_at, OLD.actor_name, OLD.action, OLD.member_id, OLD.member_name, OLD.target_name, OLD.details)
     AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id)
     AND (NEW.target_user_id IS NULL OR NEW.target_user_id IS NOT DISTINCT FROM OLD.target_user_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Le journal d''activité ne peut pas être modifié' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "activity_log_no_update" BEFORE UPDATE ON "activity_log"
  FOR EACH ROW EXECUTE FUNCTION "activity_log_refuse_update"();
--> statement-breakpoint
-- Une entrée ne disparaît qu'avec sa famille (suppression en cascade, la
-- famille n'existe alors déjà plus) : toute autre suppression est refusée.
CREATE FUNCTION "activity_log_refuse_delete"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "families" WHERE "id" = OLD.family_id) THEN
    RAISE EXCEPTION 'Les entrées du journal d''activité ne peuvent pas être supprimées' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "activity_log_no_delete" BEFORE DELETE ON "activity_log"
  FOR EACH ROW EXECUTE FUNCTION "activity_log_refuse_delete"();
