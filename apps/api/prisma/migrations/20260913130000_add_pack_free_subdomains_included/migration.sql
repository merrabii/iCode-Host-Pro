-- Bloc A (page produit 10 onglets) — Pack : nombre de sous-domaines gratuits inclus.
-- INFORMATIF pour l'instant (affiché à l'admin, onglet Packs) : la logique métier
-- d'enforcement (quota de sous-domaines utilisables par commande/client) n'est pas
-- encore décidée. null = pas précisé / non renseigné.

ALTER TABLE "HostingPack" ADD COLUMN "freeSubdomainsIncluded" INTEGER;
