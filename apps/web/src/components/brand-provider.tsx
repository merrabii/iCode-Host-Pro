'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { defaultBrandView, type BrandView } from '@/config/brand';
import { deriveBrandStyles } from '@/lib/brand-palette';

type BrandContextValue = {
  brand: BrandView;
  /** Re-fetche le branding depuis l'API (utilisé par la page admin après save). */
  refresh: () => Promise<BrandView>;
};

const BrandContext = createContext<BrandContextValue>({
  brand: defaultBrandView,
  refresh: async () => defaultBrandView,
});

export function useBrand(): BrandContextValue {
  return useContext(BrandContext);
}

/**
 * Met à jour la pile <style id="ihp-brand-style"> posée par le layout (Phase 14).
 * Application CÔTÉ CLIENT des variables --brand-* : ainsi une modification admin
 * (couleur primaire, accent) recolore toute l'UI sans rechargement de page.
 */
function applyBrandStyle(b: BrandView): void {
  try {
    const el = document.getElementById('ihp-brand-style') as HTMLStyleElement | null;
    if (el) el.textContent = deriveBrandStyles(b.primaryColor, b.accentColor);
  } catch {
    /* document indisponible (SSR) — le layout injecte déjà la bonne valeur */
  }
}

/**
 * Fournit le branding (nom, logo, couleurs) à toute l'app côté client.
 * Reçoit la valeur SERVEUR en prop `initial` (rendu sans flash), puis re-fetch
 * une fois au montage pour refléter une modification admin effectuée sur une
 * autre page sans rechargement complet. Ne lève jamais d'erreur.
 */
export function BrandProvider({
  initial,
  children,
}: {
  initial?: BrandView;
  children: ReactNode;
}) {
  const [brand, setBrand] = useState<BrandView>(initial ?? defaultBrandView);

  const refresh = useMemo(
    () => async () => {
      try {
        const api = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
        const res = await fetch(`${api}/api/brand`, { cache: 'no-store' });
        if (!res.ok) return brand;
        const b = await res.json();
        // normalisation minimale côté client
        const nb: BrandView = {
          name: typeof b?.name === 'string' && b.name ? b.name : brand.name,
          sub: typeof b?.sub === 'string' ? b.sub : brand.sub,
          tagline: b?.tagline ?? brand.tagline,
          hostname: typeof b?.hostname === 'string' ? b.hostname : brand.hostname,
          logoType: b?.logoType === 'TEXT' || b?.logoType === 'IMAGE' ? b.logoType : 'DEFAULT',
          logoText: b?.logoText ?? brand.logoText,
          logoUrl: b?.logoUrl ?? brand.logoUrl,
          logoShowText: b?.logoShowText === true,
          primaryColor: /^#[0-9a-fA-F]{6}$/.test(b?.primaryColor ?? '') ? b.primaryColor.toLowerCase() : brand.primaryColor,
          accentColor: /^#[0-9a-fA-F]{6}$/.test(b?.accentColor ?? '') ? b.accentColor.toLowerCase() : null,
        };
        // Recolore l'UI sans rechargement (le layout a déjà posé une <style id="ihp-brand-style">).
        applyBrandStyle(nb);
        setBrand(nb);
        return nb;
      } catch {
        return brand;
      }
    },
    [brand],
  );

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(() => ({ brand, refresh }), [brand, refresh]);
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}