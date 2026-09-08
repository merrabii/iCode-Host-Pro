'use client';

import { useRef, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, PageIntro, PageLoading } from '@/components/ui';
import { useToast } from '@/components/toast';
import { brandLogoUrl, deriveBrandStyles } from '@/lib/brand-palette';
import { useBrand } from '@/components/brand-provider';
import { ADMIN_NAV } from '@/config/nav';
import { useAdminSession } from '@/lib/session';
import {
  apiError,
  removeBrandLogo,
  resetBranding,
  updateBranding,
  uploadBrandLogo,
  type BrandLogoType,
  type BrandingInput,
  type BrandingPublic,
} from '@/lib/api';

interface FormState {
  name: string;
  sub: string;
  tagline: string;
  hostname: string;
  logoType: BrandLogoType;
  logoText: string;
  logoUrl: string | null;
  logoShowText: boolean;
  primaryColor: string;
  accentColor: string; // '' = pas d'accent (dérivé de la primaire)
}

function toForm(b: BrandingPublic, keepHostname = ''): FormState {
  return {
    name: b.name ?? '',
    sub: b.sub ?? '',
    tagline: b.tagline ?? '',
    hostname: keepHostname,
    logoType: b.logoType ?? 'DEFAULT',
    logoText: b.logoText ?? '',
    logoUrl: b.logoUrl ?? null,
    logoShowText: b.logoShowText === true,
    primaryColor: b.primaryColor?.toLowerCase() ?? '#00b377',
    accentColor: b.accentColor ?? '',
  };
}

const ss = {
  wrap: { maxWidth: 760 } as React.CSSProperties,
  row: { gap: 16, flexWrap: 'wrap' as const },
  logoWrap: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' as const },
  prev: { width: 30, height: 30, borderRadius: 9, display: 'grid' as const, placeItems: 'center' as const, background: 'linear-gradient(135deg, var(--brand-primary), var(--brand-primary-dark))', color: '#fff', fontWeight: 800, fontSize: 13, overflow: 'hidden' as const },
  colorRow: { display: 'flex', alignItems: 'center', gap: 10 },
};

export default function ApparencePage() {
  const toast = useToast();
  const { phase, token } = useAdminSession();
  const { brand, refresh } = useBrand();
  const fileRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<FormState>(() => ({
    name: brand.name,
    sub: brand.sub,
    tagline: brand.tagline ?? '',
    hostname: brand.hostname ?? '',
    logoType: brand.logoType,
    logoText: brand.logoText ?? '',
    logoUrl: brand.logoUrl,
    logoShowText: brand.logoShowText === true,
    primaryColor: brand.primaryColor,
    accentColor: brand.accentColor ?? '',
  }));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    if (!token) return;
    // Le nom peut être VIDE : une marque « image seule » n'affiche pas de texte.
    const name = form.name.trim();
    const primary = /^#[0-9a-fA-F]{6}$/.test(form.primaryColor) ? form.primaryColor.toLowerCase() : '';
    if (!primary) { toast.error('Couleur primaire invalide (ex. #00b377).'); return; }
    const accent = form.accentColor.trim();
    if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) { toast.error('Couleur accent invalide (ex. #34d399).'); return; }

    const dto: BrandingInput = {
      name,
      sub: form.sub,
      tagline: form.tagline.trim() || null,
      hostname: form.hostname.trim() || null,
      logoType: form.logoType,
      logoShowText: form.logoShowText,
      primaryColor: primary,
      accentColor: accent ? accent.toLowerCase() : null,
    };
    if (form.logoType === 'TEXT') dto.logoText = form.logoText.trim() || null;

    setSaving(true);
    const res = await updateBranding(token, dto);
    setSaving(false);
    if (!res.ok) { toast.error(apiError(res, 'Enregistrement impossible.')); return; }
    const b = res.data as BrandingPublic;
    setForm(toForm(b, form.hostname)); // conserve le hostname saisi (non renvoyé par le PATCH partiel)
    toast.ok('Apparence enregistrée.');
    void refresh();
  }

  async function reset() {
    if (!token) return;
    if (!window.confirm('Réinitialiser la marque au style actuel (iCode Host Pro, vert #00b377, logo par défaut) ?')) return;
    setSaving(true);
    const res = await resetBranding(token);
    setSaving(false);
    if (!res.ok) { toast.error(apiError(res, 'Réinitialisation impossible.')); return; }
    const b = res.data as BrandingPublic;
    setForm(toForm(b, form.hostname));
    toast.ok('Marque réinitialisée.');
    void refresh();
  }

  async function onPickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    if (!token) return;
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.error('Logo trop volumineux (max 2 Mo).'); return; }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Format non pris en charge (PNG, JPEG ou WebP — le SVG est refusé).');
      return;
    }
    setUploading(true);
    const res = await uploadBrandLogo(token, file);
    setUploading(false);
    if (!res.ok) { toast.error(apiError(res, 'Import du logo impossible.')); return; }
    const b = res.data as BrandingPublic;
    setForm((f) => ({ ...f, logoType: 'IMAGE', logoUrl: b.logoUrl, logoShowText: b.logoShowText === true }));
    toast.ok('Logo importé.');
    void refresh();
  }

  async function onRemoveLogo() {
    if (!token) return;
    if (!window.confirm('Supprimer ce logo (retour au logo par défaut, initiales) ?')) return;
    setRemoving(true);
    const res = await removeBrandLogo(token);
    setRemoving(false);
    if (!res.ok) { toast.error(apiError(res, 'Suppression impossible.')); return; }
    const b = res.data as BrandingPublic;
    setForm(toForm(b, form.hostname));
    toast.ok('Logo supprimé.');
    void refresh();
  }

  if (phase === 'loading') return <PageLoading label="Chargement de l’apparence…" />;
  if (phase === 'denied' || !token) {
    return (
      <AppShell me={null} nav={ADMIN_NAV} bare={false}>
        <div className="wrap-md"><Alert tone="error" title="Accès refusé">Réservé aux administrateurs.</Alert></div>
      </AppShell>
    );
  }

  const logoImg = form.logoUrl ? brandLogoUrl(form.logoUrl) : null;

  return (
    <AppShell me={{ email: 'admin', role: 'ADMIN' }} nav={ADMIN_NAV}>
      <div className="wrap-md" style={ss.wrap}>
        <PageIntro
          eyebrow="Administration · Apparence"
          title="Marque & apparence"
          sub="Tout ce qui identifie la plateforme au nom de votre client : nom, logo, couleurs. Les changements s’appliquent immédiatement."
        />

        {/* ── Identité ────────────────────────────────────────────────────── */}
        <div className="panel mt">
          <div className="panel-head"><b>Identité</b></div>
          <div className="panel-body stack" style={{ gap: 12 }}>
            <label className="field">
              <span className="field-label">Nom de la marque <span className="muted">(libre — vide si image seule)</span></span>
              <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="iCode Host Pro" />
            </label>
            <label className="field">
              <span className="field-label">Sous-titre</span>
              <input className="input" value={form.sub} onChange={(e) => set({ sub: e.target.value })} placeholder="Self-hosted hosting control plane" />
            </label>
            <div className="row" style={ss.row}>
              <label className="field flex-1">
                <span className="field-label">Tag (pilule) — ex. CLOUD</span>
                <input className="input" value={form.tagline} onChange={(e) => set({ tagline: e.target.value })} placeholder="CLOUD" />
              </label>
              <label className="field flex-1">
                <span className="field-label">Hostname (domaine de la marque)</span>
                <input className="input input-mono" value={form.hostname} onChange={(e) => set({ hostname: e.target.value })} placeholder="brand.com" />
              </label>
            </div>
            <p className="muted" style={{ fontSize: 12 }}>Le hostname est stocké et affiché ; il ne route pas (un brand par installation).</p>
          </div>
        </div>

        {/* ── Logo ─────────────────────────────────────────────────────────── */}
        <div className="panel mt">
          <div className="panel-head"><b>Logo</b></div>
          <div className="panel-body stack" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
              {([
                ['DEFAULT', 'Par défaut', 'Initiales du nom sur la pastille dégradé.'],
                ['TEXT', 'Texte', 'Wordmark stylisé (logoText ou nom).'],
                ['IMAGE', 'Image', 'Import PNG/JPEG/WebP ≤ 2 Mo (SVG refusé).'],
              ] as [BrandLogoType, string, string][]).map(([mode, label, hint]) => (
                <label key={mode} className="field" style={{ margin: 0, minWidth: 180 }}>
                  <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <input type="radio" name="logoType" checked={form.logoType === mode} onChange={() => set({ logoType: mode })} />
                    <b style={{ fontSize: 14 }}>{label}</b>
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>{hint}</span>
                </label>
              ))}
            </div>

            {form.logoType === 'TEXT' && (
              <label className="field">
                <span className="field-label">Text du logo (vide = nom de la marque)</span>
                <input className="input" value={form.logoText} onChange={(e) => set({ logoText: e.target.value })} placeholder={form.name} />
              </label>
            )}

            {form.logoType === 'IMAGE' && (
              <div className="stack" style={{ gap: 8 }}>
                <div style={ss.logoWrap}>
                  <span style={ss.prev} aria-hidden>
                    {logoImg ? <img src={logoImg} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : '◈'}
                  </span>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={onPickLogo}
                      disabled={uploading}
                    />
                    <Button variant="secondary" size="sm" disabled={uploading} busy={uploading} onClick={() => fileRef.current?.click()}>
                      {uploading ? 'Import…' : 'Choisir un logo'}
                    </Button>
                    {form.logoUrl && (
                      <Button variant="danger" size="sm" disabled={removing || uploading} busy={removing} onClick={onRemoveLogo}>
                        {removing ? 'Suppression…' : 'Supprimer le logo'}
                      </Button>
                    )}
                  </div>
                </div>
                <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={form.logoShowText}
                    onChange={(e) => set({ logoShowText: e.target.checked })}
                    disabled={!form.logoUrl}
                  />
                  <span style={{ fontSize: 13 }}>
                    Afficher aussi le texte à côté du logo (décoché = image seule, sans texte)
                  </span>
                </label>
                <p className="muted" style={{ fontSize: 12 }}>Formats : PNG, JPEG ou WebP — taille max 2 Mo. Le SVG est refusé (sécurité).</p>
              </div>
            )}

            <p className="muted" style={{ fontSize: 12 }}>
              Aperçu actuel : le logo et le nom apparaissent en haut à gauche, dans la sidebar et la navigation mobile.
            </p>
          </div>
        </div>

        {/* ── Couleurs ───────────────────────────────────────────────────────── */}
        <div className="panel mt">
          <div className="panel-head"><b>Couleurs</b></div>
          <div className="panel-body stack" style={{ gap: 12 }}>
            <div className="row" style={ss.row}>
              <label className="field flex-1">
                <span className="field-label">Couleur primaire</span>
                <div style={ss.colorRow}>
                  <input type="color" value={form.primaryColor} onChange={(e) => set({ primaryColor: e.target.value })} style={{ width: 40, height: 32, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }} />
                  <input className="input input-mono" value={form.primaryColor} onChange={(e) => set({ primaryColor: e.target.value })} placeholder="#00b377" style={{ maxWidth: 130 }} />
                </div>
              </label>
              <label className="field flex-1">
                <span className="field-label">Couleur accent (optionnelle)</span>
                <div style={ss.colorRow}>
                  <input type="color" value={form.accentColor || '#34d399'} onChange={(e) => set({ accentColor: e.target.value })} style={{ width: 40, height: 32, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }} />
                  <input className="input input-mono" value={form.accentColor} onChange={(e) => set({ accentColor: e.target.value })} placeholder="vide = dérivée" style={{ maxWidth: 150 }} />
                </div>
              </label>
            </div>
            <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge tone="ok">Votre marque</Badge>
              <span style={{ fontWeight: 700, color: `var(--brand-primary, ${form.primaryColor})` }}>{form.name || 'Votre marque'}</span>
              <span style={{ fontSize: 13 }}>— badges, items actifs, halo, globe et touches utilisent la primaire (dérivée).</span>
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              Aperçu du code injecté dans <code>#ihp-brand-style</code> (appliqué sans rechargement) :
            </p>
            <pre className="input input-mono" style={{ padding: 10, fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {deriveBrandStyles(
                /^#[0-9a-fA-F]{6}$/.test(form.primaryColor) ? form.primaryColor : '#00b377',
                /^#[0-9a-fA-F]{6}$/.test(form.accentColor) ? form.accentColor : null,
              )}
            </pre>
          </div>
        </div>

        {/* ── Actions ────────────────────────────────────────────────────────── */}
        <div className="row mt" style={{ gap: 10, flexWrap: 'wrap' }}>
          <Button onClick={save} disabled={saving || uploading} busy={saving}>Enregistrer</Button>
          <Button variant="danger" onClick={reset} disabled={saving || uploading}>Réinitialiser le style</Button>
          <Button variant="secondary" onClick={() => void refresh()} disabled={saving || uploading}>Actualiser</Button>
        </div>
      </div>
    </AppShell>
  );
}