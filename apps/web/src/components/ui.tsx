'use client';

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { IconServer, IconShield } from './icons';

/* ---- Bouton ------------------------------------------------------ */
type BtnVariant = 'primary' | 'secondary' | 'danger';
export function Button({
  variant = 'primary',
  size,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' }) {
  const cls = [
    variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : 'btn-secondary',
    size === 'sm' ? 'btn-sm' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return <button type="button" className={cls} {...rest} />;
}

/* ---- Badge --------------------------------------------------------- */
const BADGE_TONES: Record<string, string> = {
  ok: 'badge-ok',
  info: 'badge-info',
  violet: 'badge-violet',
  cyan: 'badge-cyan',
  pink: 'badge-pink',
  warn: 'badge-warn',
  danger: 'badge-danger',
  neutral: 'badge-neutral',
};
export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone | 'green' | 'blue' | 'amber' | 'gray' | 'red'; children: ReactNode }) {
  const map: Record<string, string> = {
    ...BADGE_TONES,
    green: 'badge-ok',
    blue: 'badge-info',
    amber: 'badge-warn',
    gray: 'badge-neutral',
    red: 'badge-danger',
  };
  return <span className={`badge ${map[tone] ?? 'badge-neutral'}`}>{children}</span>;
}

/* ---- Alert ---------------------------------------------------------- */
export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'ok' | 'error' | 'info' | 'warn';
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`alert ${tone}`}>
      {title && <b>{title}</b>} {title && children ? ' ' : ''}
      {children}
    </div>
  );
}

/* ---- En-tête de page + refus d'accès ------------------------------ */
export function PageIntro({ eyebrow, title, sub, children }: { eyebrow?: ReactNode; title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      {eyebrow && <div className="hero-eyebrow">{eyebrow}</div>}
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export function Denied({ message = 'Accès refusé : réservé aux administrateurs.' }: { message?: ReactNode }) {
  return (
    <div className="empty" style={{ padding: '48px 0' }}>
      <IconShield />
      <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Accès refusé</div>
      <div className="muted" style={{ fontSize: 13.5 }}>{message}</div>
      <a className="btn-secondary" href="/auth" style={{ display: 'inline-flex', marginTop: 16 }}>
        Retour à l&apos;authentification
      </a>
    </div>
  );
}

/* ---- Panel ----------------------------------------------------------- */
export function Panel({
  title,
  sub,
  linkHref,
  linkLabel = 'Voir tout',
  className,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  linkHref?: string;
  linkLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`panel${className ? ` ${className}` : ''}`}>
      <div className="panel-head">
        <div className="flex-1">
          <div className="panel-title">{title}</div>
          {sub && <div className="panel-sub">{sub}</div>}
        </div>
        {linkHref && (
          <a className="panel-link" href={linkHref}>
            {linkLabel}
          </a>
        )}
      </div>
      {children && <div className="panel-body">{children}</div>}
    </div>
  );
}

/* ---- Stat card ------------------------------------------------------- */
const STAT_TONES = ['primary', 'info', 'violet', 'amber', 'neutral', 'pink'] as const;
export function StatCard({
  label,
  value,
  unit,
  sub,
  warn,
  tone = 'primary',
  icon,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  sub?: ReactNode;
  warn?: boolean;
  tone?: (typeof STAT_TONES)[number];
  icon?: ReactNode;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className={`stat-icon ${tone}`}>{icon ?? <IconServer />}</span>
      </div>
      <div className="stat-value">
        <span className="num">{value}</span>
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub && <div className={`stat-sub${warn ? ' warn' : ''}`}>{sub}</div>}
    </div>
  );
}

/* ---- Formulaires ------------------------------------------------------ */
export function Field({ label, required, hint, className, children }: { label: ReactNode; required?: boolean; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <label>
        {label}
        {required && <span className="req"> *</span>}
      </label>
      {children}
      {hint && <span className="muted cell-sub">{hint}</span>}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input${className ? ` ${className}` : ''}`} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`select${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </select>
  );
}

/* ---- États ------------------------------------------------------------- */
export function PageLoading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="page-loading">
      <span className="spinner" />
      {label}
    </div>
  );
}

export function EmptyState({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {children}
      {title && <div className="muted" style={{ marginTop: 4 }}>{title}</div>}
    </div>
  );
}

/* ---- Statut → badge tone ------------------------------------------------ */
export function statusTone(kind: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'REJECTED' | 'CANCELLED' | 'REQUESTED' | 'PROVISIONING' | string): BadgeTone {
  switch (kind) {
    case 'ACTIVE':
    case 'PROVISIONING':
      return 'ok';
    case 'PENDING':
    case 'REQUESTED':
      return 'warn';
    case 'SUSPENDED':
      return 'warn';
    case 'REJECTED':
    case 'CANCELLED':
      return 'danger';
    default:
      return 'neutral';
  }
}
