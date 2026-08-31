'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ComponentType, ReactNode } from 'react';
import { brand, brandInitials } from '@/config/brand';
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

function roleLabel(role: string): string {
  return role === 'ADMIN' ? 'Administrateur' : 'Client';
}

export function AppShell({
  me,
  nav,
  tenant = { label: 'Espace', name: brand.name },
  footStatus = 'Système opérationnel',
  info = [],
  bare = false,
  children,
}: {
  me: ShellUser;
  nav: NavSection[];
  tenant?: { label: string; name?: string };
  footStatus?: string;
  info?: string[];
  /** Mode « bare » : topbar seule, sans sidebar — pour les écrans centrés (auth, …). */
  bare?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

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

  return (
    <>
      <header className="topbar">
        <div className="topbar-left">
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
            <button type="button" className="user-chip" onClick={() => router.replace(brand.home)}>
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
    </>
  );
}
