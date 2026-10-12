CREATE TABLE "consent_attestations" (
	"id" serial PRIMARY KEY NOT NULL,
	"family_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"member_name" varchar(210) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"declarant_user_id" integer,
	"declarant_name" varchar(150) NOT NULL,
	"signed_name" varchar(150),
	"method" varchar(20),
	"intermediary_name" varchar(150),
	"obtained_on" date,
	"text_version" varchar(30),
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "archived_reason" varchar(30);--> statement-breakpoint
ALTER TABLE "consent_attestations" ADD CONSTRAINT "consent_attestations_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_attestations" ADD CONSTRAINT "consent_attestations_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_attestations" ADD CONSTRAINT "consent_attestations_declarant_user_id_users_id_fk" FOREIGN KEY ("declarant_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_attestations_member_idx" ON "consent_attestations" USING btree ("member_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- Fiches déjà archivées avant ce lot : leur titulaire a quitté la famille.
UPDATE "members" SET "archived_reason" = 'departure' WHERE "archived_at" IS NOT NULL;
--> statement-breakpoint
-- Attestations ineffaçables (ajouté à la main : drizzle-kit ne génère pas de
-- déclencheur). Toute modification est refusée, sauf celle que fait
-- PostgreSQL lui-même à la suppression d'un compte (ON DELETE SET NULL sur
-- declarant_user_id) : l'identifiant passe à NULL, tout le reste — dont le
-- nom conservé — doit rester identique.
CREATE FUNCTION "consent_attestations_refuse_update"() RETURNS trigger AS $$
BEGIN
  IF (NEW.id, NEW.family_id, NEW.member_id, NEW.member_name, NEW.kind, NEW.declarant_name, NEW.signed_name,
      NEW.method, NEW.intermediary_name, NEW.obtained_on, NEW.text_version, NEW.created_at)
       IS NOT DISTINCT FROM
     (OLD.id, OLD.family_id, OLD.member_id, OLD.member_name, OLD.kind, OLD.declarant_name, OLD.signed_name,
      OLD.method, OLD.intermediary_name, OLD.obtained_on, OLD.text_version, OLD.created_at)
     AND (NEW.declarant_user_id IS NULL OR NEW.declarant_user_id IS NOT DISTINCT FROM OLD.declarant_user_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Une attestation de consentement ne peut pas être modifiée' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "consent_attestations_no_update" BEFORE UPDATE ON "consent_attestations"
  FOR EACH ROW EXECUTE FUNCTION "consent_attestations_refuse_update"();
--> statement-breakpoint
-- Une attestation ne disparaît qu'avec sa fiche ou sa famille (suppression en
-- cascade : la fiche ou la famille n'existe alors déjà plus) — toute autre
-- suppression est refusée.
CREATE FUNCTION "consent_attestations_refuse_delete"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "members" WHERE "id" = OLD.member_id)
     AND EXISTS (SELECT 1 FROM "families" WHERE "id" = OLD.family_id) THEN
    RAISE EXCEPTION 'Une attestation de consentement ne peut pas être supprimée' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "consent_attestations_no_delete" BEFORE DELETE ON "consent_attestations"
  FOR EACH ROW EXECUTE FUNCTION "consent_attestations_refuse_delete"();
