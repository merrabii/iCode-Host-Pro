-- Fix « aucune proposition de domaine au checkout ».
-- Cause racine : aucun produit n'avait de FreeSubdomainRule, donc le shop ne rendait
-- pas le sélecteur de sous-domaine et le checkout ne capturait jamais requestedSubdomain.
-- On attache une règle aux 3 produits payants « GitHub Deploy » (Go App, Static, Node API).
-- allowedDomainIds = {} -> tous les Domain ACTIVE (racine par défaut = first ACTIVE = codediali.com).
-- reservedPrefixes : bannir les sous-domaines system/vitrine courants.
-- Idempotente : ON CONFLICT (productId) DO NOTHING.

INSERT INTO "FreeSubdomainRule"
  ("id", "productId", "allowedDomainIds", "reservedPrefixes", "minLength", "maxLength",
   "allowedChars", "rejectPattern", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  p."id",
  '{}',
  '{admin,www,api,mail,smtp,status,files,test,dev,staging,prod}',
  3,
  40,
  'a-z0-9-',
  NULL,
  now(),
  now()
FROM "Product" p
WHERE p."slug" IN ('deploy-github-app', 'site-statique-premium', 'api-node-starter')
ON CONFLICT ("productId") DO NOTHING;