'use client';

import { brandInitials } from '@/config/brand';
import { brandLogoUrl } from '@/lib/brand-palette';
import { useBrand } from './brand-provider';

/**
 * Logo de marque : rendu selon le mode configuré.
 *  - DEFAULT : tile d'initiales (logo actuel par défaut).
 *  - TEXT    : wordmark stylisé (logoText ou nom).
 *  - IMAGE   : image importée (servie par l'API via /branding/*).
 * Utilisé dans la topbar, la sidebar et la nav mobile (sous BrandProvider).
 */
export function BrandLogo({
  size = 28,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  const { brand } = useBrand();

  if (brand.logoType === 'IMAGE' && brand.logoUrl) {
    const src = brandLogoUrl(brand.logoUrl) ?? '';
    // eslint-disable-next-line @next/next/no-img-element
    const img = (
      <img
        src={src}
        alt={brand.name}
        className={className}
        style={{ height: size, width: 'auto', maxWidth: 180, objectFit: 'contain' }}
      />
    );
    // Option « image + texte » : affiche aussi le wordmark à côté du logo.
    if (brand.logoShowText) {
      const wordmark = brand.logoText?.trim() || brand.name;
      return (
        <span
          className={className}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}
        >
          {img}
          <span
            style={{ fontSize: Math.round(size * 0.82), fontWeight: 800, letterSpacing: '0.01em' }}
          >
            {wordmark}
          </span>
        </span>
      );
    }
    return img;
  }

  if (brand.logoType === 'TEXT') {
    const wordmark = brand.logoText?.trim() || brand.name;
    return (
      <span
        className={className}
        style={{ fontSize: Math.round(size * 0.82), fontWeight: 800, letterSpacing: '0.01em' }}
      >
        {wordmark}
      </span>
    );
  }

  // DEFAULT — tile d'initiales, s'intègre au .logo-badge existant.
  return <span className={className || undefined}>{brandInitials(brand.name)}</span>;
}