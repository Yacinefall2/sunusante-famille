-- Phase B — accès dossier par dossier.
-- Le Titulaire (R1) d'une fiche devient le compte qui y est relié
-- (family_memberships.linked_member_id) ; le créateur d'une fiche
-- (members.guardian_user_id) devient une ligne Gestionnaire (R2) explicite,
-- puis la colonne guardian_user_id disparaît.

-- 1. Une personne n'a qu'un rôle par fiche : on garde la ligne la plus récente.
DELETE FROM "document_roles" a
USING "document_roles" b
WHERE a."member_id" = b."member_id" AND a."user_id" = b."user_id" AND a."id" < b."id";
--> statement-breakpoint

-- 2. Les rôles « titulaire » déjà posés relient le compte à sa fiche (une
--    fiche par compte et un compte par fiche, au sein de la même famille).
WITH candidates AS (
  SELECT DISTINCT ON (dr."member_id") fm."id" AS membership_id, dr."member_id"
  FROM "document_roles" dr
  JOIN "members" m ON m."id" = dr."member_id"
  JOIN "family_memberships" fm ON fm."user_id" = dr."user_id" AND fm."family_id" = m."family_id"
  WHERE dr."role" = 'titulaire'
    AND fm."linked_member_id" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "family_memberships" o WHERE o."linked_member_id" = dr."member_id")
  ORDER BY dr."member_id", dr."created_at"
), one_per_membership AS (
  SELECT DISTINCT ON (membership_id) membership_id, "member_id"
  FROM candidates
  ORDER BY membership_id, "member_id"
)
UPDATE "family_memberships" fm
SET "linked_member_id" = c."member_id"
FROM one_per_membership c
WHERE fm."id" = c.membership_id;
--> statement-breakpoint

-- 3. Comptes encore sans fiche : rapprochement par le nom (prénom seul ou
--    prénom + nom), uniquement quand la correspondance est sans ambiguïté
--    dans les deux sens. Les autres comptes choisiront leur fiche à la
--    prochaine connexion.
WITH candidates AS (
  SELECT fm."id" AS membership_id, m."id" AS member_id
  FROM "family_memberships" fm
  JOIN "users" u ON u."id" = fm."user_id"
  JOIN "members" m ON m."family_id" = fm."family_id"
  WHERE fm."linked_member_id" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "family_memberships" o WHERE o."linked_member_id" = m."id")
    AND lower(trim(u."name")) IN (lower(trim(m."first_name")), lower(trim(m."first_name" || ' ' || m."last_name")))
), unique_per_membership AS (
  SELECT membership_id, min(member_id) AS member_id
  FROM candidates
  GROUP BY membership_id
  HAVING count(*) = 1
), unique_both_ways AS (
  SELECT membership_id, member_id
  FROM unique_per_membership
  WHERE member_id IN (SELECT member_id FROM unique_per_membership GROUP BY member_id HAVING count(*) = 1)
)
UPDATE "family_memberships" fm
SET "linked_member_id" = c.member_id
FROM unique_both_ways c
WHERE fm."id" = c.membership_id;
--> statement-breakpoint

-- 4. Le rôle « titulaire » ne se stocke plus dans document_roles : supprimé
--    là où il est désormais porté par le lien, converti en Gestionnaire
--    ailleurs (aucun droit perdu).
DELETE FROM "document_roles" dr
USING "members" m, "family_memberships" fm
WHERE dr."role" = 'titulaire'
  AND m."id" = dr."member_id"
  AND fm."user_id" = dr."user_id"
  AND fm."family_id" = m."family_id"
  AND fm."linked_member_id" = dr."member_id";
--> statement-breakpoint
UPDATE "document_roles" SET "role" = 'gestionnaire' WHERE "role" = 'titulaire';
--> statement-breakpoint

-- Invitations non encore acceptées qui proposaient « titulaire » : la fiche
-- devient la fiche de la personne invitée.
UPDATE "pending_invitations"
SET "linked_member_id" = COALESCE("linked_member_id", "document_member_id"),
    "document_member_id" = NULL,
    "document_role" = NULL
WHERE "document_role" = 'titulaire' AND "accepted_at" IS NULL;
--> statement-breakpoint

-- 5. Le créateur d'une fiche (hors sa propre fiche) en devient Gestionnaire,
--    s'il appartient toujours à la famille.
INSERT INTO "document_roles" ("member_id", "user_id", "role")
SELECT m."id", m."guardian_user_id", 'gestionnaire'
FROM "members" m
JOIN "family_memberships" fm ON fm."user_id" = m."guardian_user_id" AND fm."family_id" = m."family_id"
WHERE m."guardian_user_id" IS NOT NULL
  AND fm."linked_member_id" IS DISTINCT FROM m."id"
  AND NOT EXISTS (
    SELECT 1 FROM "document_roles" d WHERE d."member_id" = m."id" AND d."user_id" = m."guardian_user_id"
  );
--> statement-breakpoint

-- 6. Schéma (généré par drizzle-kit).
ALTER TABLE "members" DROP CONSTRAINT "members_guardian_user_id_users_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "document_roles_member_user_uq" ON "document_roles" USING btree ("member_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "family_memberships_linked_member_uq" ON "family_memberships" USING btree ("linked_member_id") WHERE "family_memberships"."linked_member_id" is not null;--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "guardian_user_id";
