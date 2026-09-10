-- RECONCILIATION DU DRIFT Phase 3 (base de dev).
-- Cause : une tentative NON LIVREE `init_domain` (jamais commitee, ligne orpheline
-- du registre _prisma_migrations, supprimee) a cree en base des objets qui ne font
-- pas partie du schema canonique produit par les migrations livrees :
--
--   * 2 enums orphelins auxquels AUCUNE colonne ne fait reference :
--       - DomainDnsManagement
--       - DomainType
--   * le type enum "DomainStatus" enrichi avec des variantes fantomes
--       (PENDING_VERIFICATION, FAILED, ARCHIVED) et SANS la variante DISABLED.
--     La migration livree `add_cloudflare_dns` recree la table "Domain" mais le
--     type, cree en `IF NOT EXISTS`, a SURVECU -> la table porte donc le type
--     enrichi. Le code applicatif utilise pourtant DomainStatus.DISABLED :
--     sans mise a jour, un passage en DISABLED echouerait en base.
--
-- Cette migration aligne la base sur le modele canonique SANS perte de donnees
-- (les lignes "Domain" portent toutes 'ACTIVE' et passent a travers le re-cast).
-- Elle est IDEMPOTENTE / NO-OP sur une base saine (tous les objets sont gardes
-- par IF EXISTS / garde de variante), donc rejouable sur un environnement neuf.

-- Enums orphelins : aucun objet ne les reference (verifie), drop sans risque.
DROP TYPE IF EXISTS "DomainDnsManagement";
DROP TYPE IF EXISTS "DomainType";

-- Realignement du type "DomainStatus" vers {ACTIVE, DISABLED}, uniquement si une
-- variante fantome est presente. No-op si la base est deja canonique.
DO $$
DECLARE
  v_has_rich boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'DomainStatus'
      AND e.enumlabel IN ('PENDING_VERIFICATION', 'FAILED', 'ARCHIVED')
  ) INTO v_has_rich;

  IF v_has_rich THEN
    -- Delier la colonne du type enrichi, recreer le type canonique, recoller.
    -- NB: il faut aussi larguer le DEFAULT ('ACTIVE') qui depend du type, sinon
    -- le DROP TYPE est refuse (2BP01). On le recapote apres le recollage.
    ALTER TABLE "Domain" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "Domain" ALTER COLUMN "status" TYPE text;
    DROP TYPE "DomainStatus";
    CREATE TYPE "DomainStatus" AS ENUM ('ACTIVE', 'DISABLED');
    ALTER TABLE "Domain" ALTER COLUMN "status" TYPE "DomainStatus" USING ("status"::text::"DomainStatus");
    ALTER TABLE "Domain" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
  END IF;
END $$;