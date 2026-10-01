'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useBrand } from './brand-provider';
import { BrandLogo } from './brand-logo';
import { roleLabel } from '@/lib/session';
import { IconLogOut, IconRefresh, IconUser } from './icons';
import { ThemeToggle } from './theme-toggle';

export type NavBadge = { text: string; tone?: 'ok' | 'info' | 'violet' | 'warn' };
export type NavItem = {
  label: string;
  href: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  badge?: NavBadge;
};
export type NavSection = { section?: string; items: NavItem[] };
export type ShellUser = { name?: string | null; email: string; role: string } | null;

function userInitials(user: NonNullable<ShellUser>): string {
  if (user.name) {
    const parts = user.name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 1) return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
  }
  return user.email.slice(0, 2).toUpperCase();
}

/** Impersonation banner (admin/support "as client") — red, with a return link. */
export function ImpersonationBanner({
  targetEmail,
  kind,
  onReturn,
}: {
  targetEmail: string;
  kind: 'admin' | 'support';
  onReturn?: () => void;
}) {
  return (
    <div className="imp-banner" role="banner">
      <span className="dot" />
      <span>
        Vous consultez l&apos;espace de <b>{targetEmail}</b> (session{' '}
        {kind === 'admin' ? 'admin' : 'support'} · lecture seule).
      </span>
      {onReturn && (
        <button type="button" className="btn-secondary btn-sm" onClick={onReturn}>
          Revenir
        </button>
      )}
    </div>
  );
}

export function AppShell({
  me,
  nav,
  tenant = { label: 'Espace' },
  footStatus = 'Système opérationnel',
  info = [],
  banner = null,
  bare = false,
  activeHref = null,
  children,
}: {
  me: ShellUser;
  nav: NavSection[];
  tenant?: { label: string; name?: string };
  footStatus?: string;
  info?: string[];
  /** Bandeau d'impersonation (lecture seule) rendu au-dessus du contenu. */
  banner?: ReactNode;
  /** Mode « bare » : topbar seule, sans sidebar — pour les écrans centrés (auth, …). */
  bare?: boolean;
  /** Contexte actif pour les entrées à query (ex. `/client?rub=host`) : ces
   *  entrées ne portent pas de path propre, la page passée en page courante. */
  activeHref?: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { brand } = useBrand();

  // Tiroir de navigation mobile (repliée < 900px).
  const [navOpen, setNavOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  // Popover du pied de sidebar (profil / déconnexion) — proposition C.
  const [footOpen, setFootOpen] = useState(false);
  useEffect(() => {
    if (!footOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || !t.closest?.('.foot-user')) setFootOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFootOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [footOpen]);

  // Verrouille le défilement de la page quand le tiroir est ouvert.
  useEffect(() => {
    document.body.classList.toggle('mobile-nav-open', navOpen);
    return () => document.body.classList.remove('mobile-nav-open');
  }, [navOpen]);

  // Navigation entrée → referme le tiroir.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  const drawerWasOpen = useRef(false);
  useEffect(() => {
    if (!navOpen) {
      if (drawerWasOpen.current) {
        drawerWasOpen.current = false;
        const el = document.activeElement;
        const inDrawer = !!el && !!drawerRef.current && drawerRef.current.contains(el);
        if (!el || el === document.body || el === document.documentElement || inDrawer) {
          hamburgerRef.current?.focus();
        }
      }
      return;
    }
    drawerWasOpen.current = true;
    drawerRef.current?.querySelector<HTMLElement>('[data-nav-close]')?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setNavOpen(false);
        return;
      }
      if (e.key !== 'Tab' || !drawerRef.current) return;
      const focusables = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && drawerRef.current.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navOpen]);

  function isActive(href: string): boolean {
    // Entrée à query (rubriques `/client?rub=…`) : pathname seul ne suffit pas,
    // comparée au contexte actif fourni par la page courante.
    if (href.includes('?')) return activeHref ? href === activeHref : false;
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(href + '/');
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      /* déconnexion locale quoi qu'il arrive */
    }
    router.replace('/auth');
  }

  const navTree = (
    <>
      {nav.map((s, i) => (
        <nav key={s.section ?? i} className="nav" aria-label={s.section ?? 'Navigation'}>
          {s.section && <div className="nav-section-label">{s.section}</div>}
          {s.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item${isActive(item.href) ? ' active' : ''}`}
              onClick={() => setNavOpen(false)}
            >
              <span className="nav-item-left">
                <item.icon />
                <span className="nav-item-label">{item.label}</span>
              </span>
              {item.badge && (
                <span className={`nav-badge${item.badge.tone ? ` ${item.badge.tone}` : ''}`}>{item.badge.text}</span>
              )}
            </Link>
          ))}
        </nav>
      ))}
    </>
  );

  const sideFoot = (
    <div className="sidebar-foot">
      <div className="foot-status">
        <span className="dot" />
        {footStatus}
      </div>
      <div className="foot-user">
        {me ? (
          <>
            <button
              type="button"
              className="foot-user-btn"
              aria-haspopup="menu"
              aria-expanded={footOpen}
              onClick={() => setFootOpen((o) => !o)}
            >
              <IconUser />
              <span className="flex-1">
                <div className="foot-user-name">{me.name || me.email}</div>
                <div className="foot-user-mail">
                  {roleLabel(me.role)} — {me.email}
                </div>
              </span>
            </button>
            {footOpen && (
              <div className="foot-user-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="foot-popover-item"
                  onClick={() => {
                    setFootOpen(false);
                    router.replace('/profil');
                  }}
                >
                  <IconUser />
                  Mon profil
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="foot-popover-item danger"
                  onClick={() => {
                    setFootOpen(false);
                    void logout();
                  }}
                >
                  <IconLogOut />
                  Déconnexion
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="foot-user-btn">
            <IconUser />
            <span className="flex-1">
              <div className="foot-user-name">Non connecté</div>
            </span>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <header className="topbar">
        <div className="topbar-left">
          {!bare && (
            <button
              type="button"
              ref={hamburgerRef}
              className={`hamburger${navOpen ? ' open' : ''}`}
              onClick={() => setNavOpen((o) => !o)}
              aria-label={navOpen ? 'Fermer la navigation' : 'Ouvrir la navigation'}
              aria-expanded={navOpen}
            >
              <span />
            </button>
          )}
          <Link
            href="/"
            className={brand.logoType === 'DEFAULT' ? 'logo-badge' : 'logo-badge-wrap'}
            aria-label={brand.name}
          >
            <BrandLogo size={brand.logoType === 'DEFAULT' ? 24 : 30} />
          </Link>
          {brand.logoType !== 'IMAGE' && (
            <div className="brand-col">
              <div className="brand-line">
                <span className="brand-title">{brand.name}</span>
                {brand.tagline && (
                  <span className="pill-tag">
                    <span className="dot" />
                    {brand.tagline}
                  </span>
                )}
              </div>
              <span className="brand-sub">{brand.sub}</span>
            </div>
          )}
        </div>

        {info.length > 0 && (
          <div className="topbar-mid">
            {info.map((t) => (
              <span key={t} className="info-pill">
                <span className="dot" />
                {t}
              </span>
            ))}
          </div>
        )}

        <div className="topbar-right">
          <ThemeToggle />
          {me && (
            <button
              type="button"
              className="user-chip"
              onClick={() => router.replace('/profil')}
              aria-label={`Ouvrir le profil de ${me.name || me.email}`}
              title="Mon profil"
            >
              <span className="avatar">{userInitials(me)}</span>
              <span>
                <div className="user-name">{me.name || me.email}</div>
                <div className="user-role">{roleLabel(me.role)}</div>
              </span>
            </button>
          )}
          {me && (
            <button type="button" className="icon-btn" onClick={logout} title="Se déconnecter" aria-label="Se déconnecter">
              <IconLogOut />
            </button>
          )}
        </div>
      </header>

      {banner && <div className="imp-banner-wrap">{banner}</div>}

      {bare && <main className="auth-wrap">{children}</main>}

      {!bare && <div className="shell">
        <aside className="sidebar">
          <div className="tenant-label">{tenant.label}</div>
          <div className="tenant-box">
            {brand.logoType === 'DEFAULT' ? (
              <span className="logo-badge" aria-hidden>
                <BrandLogo size={24} />
              </span>
            ) : (
              <BrandLogo size={26} />
            )}
            {brand.logoType !== 'IMAGE' && (
              <div className="brand-col flex-1">
                <span className="brand-title">{tenant.name ?? brand.name}</span>
                <span className="brand-sub">{brand.sub}</span>
              </div>
            )}
          </div>

          {navTree}

          <button type="button" className="refresh-btn" onClick={() => window.location.reload()}>
            <IconRefresh />
            Actualiser
          </button>

          {sideFoot}
        </aside>

        <main className="main">{children}</main>
      </div>}

      {/* ── Tiroir de navigation mobile (repliée < 900px) ─────────────── */}
      {!bare && (
        <>
          <div
            className={`mobile-nav-overlay${navOpen ? ' open' : ''}`}
            onClick={() => setNavOpen(false)}
            aria-hidden
          />
          <aside
            ref={drawerRef}
            className={`mobile-nav${navOpen ? ' open' : ''}`}
            aria-label="Navigation mobile"
            inert={!navOpen}
          >
            <div className="mobile-nav-head">
              {brand.logoType === 'DEFAULT' ? (
                <span className="logo-badge" aria-hidden>
                  <BrandLogo size={24} />
                </span>
              ) : (
                <BrandLogo size={26} />
              )}
              <div className="brand-col flex-1">
                <span className="brand-title">{brand.name}</span>
                <span className="brand-sub">{brand.sub}</span>
              </div>
              <button
                type="button"
                className="icon-btn"
                data-nav-close
                onClick={() => setNavOpen(false)}
                aria-label="Fermer la navigation"
              >
                ✕
              </button>
            </div>
            {navTree}
            <button type="button" className="refresh-btn" onClick={() => window.location.reload()}>
              <IconRefresh />
              Actualiser
            </button>
            {sideFoot}
          </aside>
        </>
      )}
    </>
  );
}
