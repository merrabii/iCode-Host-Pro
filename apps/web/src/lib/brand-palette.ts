/**
 * Phase 14 — dérivation de la palette de marque (couleur primaire + accent).
 * Le reste de l'UI (active-bg, glows, badges green, globe, tints) est dérivé
 * dans globals.css via `color-mix()` depuis `--brand-primary` — on n'injecte
 * donc QUE les trois variables de base, en `!important` pour gagner contre
 * globals.css quel que soit l'ordre des feuilles (sinon flash de la couleur).
 */

export type Hex = string; // #rrggbb (6 chiffres)

function hexToRgb(hex: Hex): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  if (Number.isNaN(n)) return [0, 179, 119];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): Hex {
  const c = (x: number) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toLowerCase();
}

/** Clamp + arrondi vers la cible `amt` (0..1) pour un canal. */
function mixChannel(a: number, b: number, amt: number): number {
  return a + (b - a) * amt;
}

/** Mélange vers une cible (black/white) exprimée en hex. */
function mixToward(hex: Hex, target: Hex, amt: number): Hex {
  const [r1, g1, b1] = hexToRgb(hex);
  const [r2, g2, b2] = hexToRgb(target);
  return toHex(
    mixChannel(r1, r2, amt),
    mixChannel(g1, g2, amt),
    mixChannel(b1, b2, amt),
  );
}

export const darken = (hex: Hex, amt = 0.12): Hex => mixToward(hex, '#000000', amt);
export const lighten = (hex: Hex, amt = 0.2): Hex => mixToward(hex, '#ffffff', amt);

/**
 * Calcule les variables CSS de marque à injecter dans :root.
 * `accent` optionnel : par défaut = primaire éclairci (livrement), sinon la
 * valeur choisie. Renvoie la feuille complète avec `!important`.
 */
export function deriveBrandStyles(primary: Hex = '#00b377', accent?: Hex | null): string {
  const p = primary.toLowerCase();
  const a = accent?.toLowerCase() ?? lighten(p, 0.2);
  return (
    `:root{` +
    `--brand-primary:${p} !important;` +
    `--brand-primary-dark:${darken(p, 0.12)} !important;` +
    `--brand-accent:${a} !important;` +
    `}`
  );
}

/** Nom de sortie d'un fichier logo vers son URL publique servie par l'API. */
export function brandLogoUrl(relative: string | null): string | null {
  if (!relative) return null;
  if (/^https?:\/\//.test(relative)) return relative;
  const api = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  return `${api}${relative.startsWith('/') ? relative : '/' + relative}`;
}