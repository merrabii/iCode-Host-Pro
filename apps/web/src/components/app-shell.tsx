'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { brand, brandInitials } from '@/config/brand';
import { roleLabel } from '@/lib/session';
import { IconChevronDown, IconLogOut, IconRefresh, IconUser } from './icons';
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
  tenant = { label: 'Espace', name: brand.name },
  footStatus = 'Système opérationnel',
  info = [],
  banner = null,
  bare = false,
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
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  // Tiroir de navigation mobile (repliée < 900px).
  const [navOpen, setNavOpen] = useState(false);

  // Verrouille le défilement de la page quand le tiroir est ouvert.
  useEffect(() => {
    document.body.classList.toggle('mobile-nav-open', navOpen);
    return () => document.body.classList.remove('mobile-nav-open');
  }, [navOpen]);

  // Navigation entrée → referme le tiroir.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  function isActive(href: string): boolean {
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
            <Link key={item.href} href={item.href} className={`nav-item${isActive(item.href) ? ' active' : ''}`}>
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

  return (
    <>
      <header className="topbar">
        <div className="topbar-left">
          {!bare && (
            <button
              type="button"
              className={`hamburger${navOpen ? ' open' : ''}`}
              onClick={() => setNavOpen((o) => !o)}
              aria-label={navOpen ? 'Fermer la navigation' : 'Ouvrir la navigation'}
              aria-expanded={navOpen}
            >
              <span />
            </button>
          )}
          <Link href={brand.home} className="logo-badge" aria-label={brand.name}>
            {brandInitials()}
          </Link>
          <div className="brand-col">
            <div className="brand-line">
              <span className="brand-title">{brand.name}</span>
              {brand.tag && (
                <span className="pill-tag">
                  <span className="dot" />
                  {brand.tag}
                </span>
              )}
            </div>
            <span className="brand-sub">{brand.sub}</span>
          </div>
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
            <button type="button" className="user-chip" onClick={() => router.replace('/profil')}>
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
            <span className="logo-badge" aria-hidden>
              {brandInitials()}
            </span>
            <div className="brand-col flex-1">
              <span className="brand-title">{tenant.name ?? brand.name}</span>
              <span className="brand-sub">{brand.sub}</span>
            </div>
            <IconChevronDown className="chevron" />
          </div>

          {navTree}

          <button type="button" className="refresh-btn" onClick={() => window.location.reload()}>
            <IconRefresh />
            Actualiser
          </button>

          <div className="sidebar-foot">
            <div className="foot-status">
              <span className="dot" />
              {footStatus}
            </div>
            <div className="foot-user">
              <IconUser />
              <div className="flex-1">
                <div className="foot-user-name">{me ? me.name || me.email : 'Non connecté'}</div>
                {me && <div className="foot-user-mail">{roleLabel(me.role)} — {me.email}</div>}
              </div>
            </div>
          </div>
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
          <aside className={`mobile-nav${navOpen ? ' open' : ''}`} aria-label="Navigation mobile">
            <div className="mobile-nav-head">
              <span className="logo-badge" aria-hidden>{brandInitials()}</span>
              <div className="brand-col flex-1">
                <span className="brand-title">{brand.name}</span>
                <span className="brand-sub">{brand.sub}</span>
              </div>
            </div>
            {navTree}
            <button type="button" className="refresh-btn" onClick={() => window.location.reload()}>
              <IconRefresh />
              Actualiser
            </button>
            <div className="sidebar-foot">
              <div className="foot-status">
                <span className="dot" />
                {footStatus}
              </div>
              <div className="foot-user">
                <IconUser />
                <div className="flex-1">
                  <div className="foot-user-name">{me ? me.name || me.email : 'Non connecté'}</div>
                  {me && <div className="foot-user-mail">{roleLabel(me.role)} — {me.email}</div>}
                </div>
              </div>
            </div>
          </aside>
        </>
      )}
    </>
  );
}
