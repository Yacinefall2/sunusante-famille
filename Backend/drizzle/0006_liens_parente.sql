ALTER TABLE "members" ADD COLUMN "kinship" varchar(30);--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "kinship_related_member_id" integer;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_kinship_related_member_id_members_id_fk" FOREIGN KEY ("kinship_related_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- La fiche d'un administrateur (Parent) du foyer est celle d'un « parent ».
UPDATE "members" m SET "kinship" = 'parent'
FROM "family_memberships" fm
WHERE fm."linked_member_id" = m."id" AND fm."role" = 'parent';
