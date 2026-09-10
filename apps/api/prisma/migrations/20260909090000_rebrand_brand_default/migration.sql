-- Rebrand Code Diali : default du nom de marque (BrandConfig.name).
-- Additif : change UNIQUEMENT le DEFAULT de la colonne, aucune donnée touchée.
-- (Le runtime tire le nom de BRAND_DEFAULTS + la ligne DB, déjà passés à Code Diali.)
ALTER TABLE "BrandConfig" ALTER COLUMN "name" SET DEFAULT 'Code Diali';