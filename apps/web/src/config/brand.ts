/**
 * MARQUE — SEUL ENDROIT qui nomme le produit (design brand-agnostic, ADR-023).
 * Brand : « Code Diali » — codediali.com. Modifier ce fichier + les tokens
 * `--brand-primary*` de globals.css.
 */
export const brand = {
  /** Nom du produit affiché dans la topbar. */
  name: 'Code Diali',
  /** Sous-titre sous le nom. */
  sub: 'Self-hosted hosting control plane',
  /** Tag de pilule (ex. 'CLOUD'). null = aucun. Frappé de la marque librement. */
  tag: 'CLOUD' as string | null,
  /** Lien de la "home" (logo clickable) — la landing page de conversion est sur /. */
  home: '/',
};

/** Initiales affichées dans le logo (tile) : 1re lettre des 2 premiers mots. */
export function brandInitials(name: string = brand.name): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '◈';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Mode de logo — aligné sur l'enum Prisma BrandLogoType. */
export type BrandLogoType = 'DEFAULT' | 'TEXT' | 'IMAGE';

/** Vue complète du branding renvoyée par GET /api/brand (Phase 14). */
export type BrandView = {
  name: string;
  sub: string;
  tagline: string | null;
  hostname: string | null;
  logoType: BrandLogoType;
  logoText: string | null;
  logoUrl: string | null;
  logoShowText: boolean;
  primaryColor: string;
  accentColor: string | null;
};

/**
 * Valeurs PAR DÉFAUT = marque actuelle gravée ici (et #00b377 dans globals.css).
 * Utilisé en fallback si GET /api/brand échoue et pour l'aperçu « reset ».
 */
export const defaultBrandView: BrandView = {
  name: brand.name,
  sub: brand.sub,
  tagline: brand.tag,
  hostname: null,
  logoType: 'DEFAULT',
  logoText: null,
  logoUrl: null,
  logoShowText: false,
  primaryColor: '#00b377',
  accentColor: null,
};
