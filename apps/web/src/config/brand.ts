/**
 * MARQUE — SEUL ENDROIT qui nomme le produit (design brand-agnostic, ADR-023).
 * Un rebrand (« iCode Host Pro » → « Code Diali » codediali.com, différé par le
 * propriétaire) = modifier ce fichier + les tokens `--brand-primary*` de globals.css.
 */
export const brand = {
  /** Nom du produit affiché dans la topbar. */
  name: 'iCode Host Pro',
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
