import { defaultBrandView, type BrandView } from '@/config/brand';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/** Normalise la réponse de /api/brand (résiliente aux champs manquants). */
function normalize(raw: unknown): BrandView {
  const o = (raw ?? {}) as Partial<BrandView>;
  return {
    name: typeof o.name === 'string' && o.name.trim() ? o.name : defaultBrandView.name,
    sub: typeof o.sub === 'string' ? o.sub : defaultBrandView.sub,
    tagline: o.tagline ?? defaultBrandView.tagline,
    hostname: typeof o.hostname === 'string' ? o.hostname : defaultBrandView.hostname,
    logoType: o.logoType === 'TEXT' || o.logoType === 'IMAGE' ? o.logoType : 'DEFAULT',
    logoText: o.logoText ?? null,
    logoUrl: o.logoUrl ?? null,
    logoShowText: o.logoShowText === true,
    primaryColor: /^#[0-9a-fA-F]{6}$/.test(o.primaryColor ?? '')
      ? o.primaryColor!.toLowerCase()
      : defaultBrandView.primaryColor,
    accentColor: /^#[0-9a-fA-F]{6}$/.test(o.accentColor ?? '')
      ? o.accentColor!.toLowerCase()
      : null,
  };
}

/**
 * Chargement du branding depuis GET /api/brand. Utilisé côté SERVEUR (layout,
 * generateMetadata) pour un rendu sans flash. Fallback = marque par défaut si
 * l'API est injoignable (aucune exception : la plateforme doit rester utilisable
 * même si le branding ne répond pas).
 */
export async function fetchBrandData(): Promise<BrandView> {
  try {
    const res = await fetch(`${API}/api/brand`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`brand:${res.status}`);
    return normalize(await res.json());
  } catch {
    return { ...defaultBrandView };
  }
}