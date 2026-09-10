'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useBrand } from './brand-provider';
import { BrandLogo } from './brand-logo';
import { CartProvider, useCart } from './cart-provider';
import { IconCart, IconShield } from './icons';
import { ThemeToggle } from './theme-toggle';

/** Bouton panier avec badge (nb d'éléments configurés). */
function CartButton() {
  const { count } = useCart();
  return (
    <Link href="/cart" className="store-cart-btn" aria-label={`Panier (${count})`}>
      <IconCart size={18} />
      {count > 0 && <span className="store-cart-badge">{count}</span>}
    </Link>
  );
}

/**
 * Layout public "boutique" — topbar marque + navigation + panier, contenu en
 * largeur vitrine, footer. Aucune sidebar (grand store moderne), le panier est
 * fourni via <CartProvider>. Utilisé par /shop/* et /checkout/*.
 */
export function StoreShell({ children }: { children: ReactNode }) {
  const { brand } = useBrand();
  return (
    <CartProvider>
      <div className="store">
        <header className="store-topbar">
          <Link href="/" className="store-brand" aria-label={brand.name}>
            <BrandLogo size={26} />
            <span className="store-brand-text">
              <span className="store-brand-name">{brand.name}</span>
              {brand.tagline && <span className="store-brand-tag">{brand.tagline}</span>}
            </span>
          </Link>

          <nav className="store-nav" aria-label="Boutique">
            <Link href="/shop">Boutique</Link>
            <Link href="/aide">Aide</Link>
            <Link href="/auth">Connexion</Link>
          </nav>

          <div className="store-topbar-right">
            <ThemeToggle />
            <CartButton />
          </div>
        </header>

        <main className="store-main">{children}</main>

        <footer className="store-footer">
          <span className="store-footer-brand">
            © {new Date().getFullYear()} {brand.name} — {brand.sub}
          </span>
          <span className="store-footer-secure">
            <IconShield size={13} /> Paiement sécurisé &amp; données protégées
          </span>
        </footer>
      </div>
    </CartProvider>
  );
}