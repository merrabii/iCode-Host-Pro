'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useBrand } from './brand-provider';
import { BrandLogo } from './brand-logo';
import { CartProvider, useCart } from './cart-provider';
import { IconCart, IconMenu, IconShield, IconX } from './icons';
import { ThemeToggle } from './theme-toggle';
import { fetchMe, getSessionToken } from '@/lib/api';

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
 * Nav boutique : Boutique / Aide / session. Le libellé de session reflète la
 * session réelle (« Connexion » anonyme, « Mon compte » si une session est
 * valide — vérifiée par `fetchMe`, pas seulement la présence d'un jeton).
 */
function StoreNavLinks({ authed, onNavigate }: { authed: boolean | null; onNavigate?: () => void }) {
  return (
    <>
      <Link href="/shop" onClick={onNavigate}>Boutique</Link>
      <Link href="/aide" onClick={onNavigate}>Aide</Link>
      {authed === null ? (
        // Session encore indéterminée : destination sûre (auth → retour en cas
        // de session valide), sans libellé promettant un espace client.
        <Link href="/auth" onClick={onNavigate}>Connexion</Link>
      ) : authed ? (
        <Link href="/client" onClick={onNavigate}>Mon compte</Link>
      ) : (
        <Link href="/auth" onClick={onNavigate}>Connexion</Link>
      )}
    </>
  );
}

/**
 * Layout public "boutique" — topbar marque + navigation + panier, contenu en
 * largeur vitrine, footer. Aucune sidebar (grand store moderne), le panier est
 * fourni via <CartProvider>. Utilisé par /shop/* et /checkout/*.
 *
 * B1 : navigation mobile via un menu à repli accessible au clavier
 * (bouton aria-expanded/aria-controls, fermeture par Escape avec restitution
 * du focus, fermeture à la sélection d'un lien).
 */
export function StoreShell({ children }: { children: ReactNode }) {
  const { brand } = useBrand();
  const [menuOpen, setMenuOpen] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);

  // Détection de session (une seule fois par montage du shell).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const token = await getSessionToken();
        if (!token) { if (alive) setAuthed(false); return; }
        const me = await fetchMe(token);
        if (alive) setAuthed(!!me);
      } catch {
        if (alive) setAuthed(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Escape ferme le menu et rend le focus au bouton.
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        menuBtnRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

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

          <button
            ref={menuBtnRef}
            type="button"
            className="store-menu-btn"
            aria-expanded={menuOpen}
            aria-controls="store-nav"
            aria-label={menuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? <IconX size={18} /> : <IconMenu size={18} />}
          </button>

          <nav id="store-nav" className={`store-nav${menuOpen ? ' open' : ''}`} aria-label="Boutique">
            <StoreNavLinks authed={authed} onNavigate={() => setMenuOpen(false)} />
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
