'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, PageIntro, PageLoading } from '@/components/ui';
import { useToast } from '@/components/toast';
import { ADMIN_NAV } from '@/config/nav';
import { useAdminSession } from '@/lib/session';
import { getSecuritySettings, updateSecuritySettings, type SecuritySettings } from '@/lib/api';

interface FlagDef {
  key: keyof Pick<SecuritySettings, 'turnstileEnabled' | 'oauthGoogleEnabled' | 'oauthGithubEnabled' | 'mfaRequiredForAdmins' | 'selfRegistrationEnabled' | 'deployEnabled'>;
  label: string;
  desc: string;
  tone?: 'ok' | 'warn' | 'info' | 'violet';
}

const FLAGS: FlagDef[] = [
  { key: 'turnstileEnabled', label: 'Cloudflare Turnstile', desc: 'Anti-bot sur le login. Effectif seulement si une clé site + clé secret Turnstile sont configurées.', tone: 'violet' },
  { key: 'oauthGoogleEnabled', label: 'Connexion Google', desc: 'Bouton « Continuer avec Google » (login, liaison et inscription à la commande).', tone: 'info' },
  { key: 'oauthGithubEnabled', label: 'Connexion GitHub', desc: 'Bouton « Continuer avec GitHub ».', tone: 'info' },
  { key: 'mfaRequiredForAdmins', label: 'MFA obligatoire pour les admins', desc: "Un administrateur sans double authentification est invité à l'activer avant de se connecter.", tone: 'ok' },
  { key: 'selfRegistrationEnabled', label: 'Inscription à la commande', desc: "Autorise la création d'un compte au moment de passer commande.", tone: 'warn' },
  { key: 'deployEnabled', label: 'Déploiements GitHub → Coolify', desc: "Active l'autodétection des dépôts et le déploiement (Phase 10bis).", tone: 'violet' },
];

const ss = {
  wrap: { maxWidth: 760 } as React.CSSProperties,
  panelBody: { display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' as const },
};

export default function SecuritePage() {
  const toast = useToast();
  const { phase, token } = useAdminSession();
  const [settings, setSettings] = useState<SecuritySettings | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Phase 11 — clés Turnstile (admin-managed, secret write-only)
  const [siteKey, setSiteKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [savingKeys, setSavingKeys] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await getSecuritySettings(token);
    if (res.ok) {
      const data = res.data as SecuritySettings;
      setSettings(data);
      setSiteKey(data.turnstileSiteKey ?? '');
    } else toast.error((res.data as { message?: string })?.message ?? 'Lecture impossible.');
  }, [token, toast]);

  useEffect(() => { if (phase === 'ready') load(); }, [phase, load]);

  async function toggle(key: keyof SecuritySettings, value: boolean) {
    if (!token) return;
    setBusyKey(key);
    const res = await updateSecuritySettings(token, { [key]: value } as never);
    setBusyKey(null);
    if (!res.ok) { toast.error((res.data as { message?: string })?.message ?? 'Mise à jour impossible.'); load(); return; }
    setSettings(res.data as SecuritySettings);
    toast.ok('Option mise à jour.');
  }

  async function saveKeys() {
    if (!token || !settings) return;
    setSavingKeys(true);
    const dto: Record<string, string> = {};
    const nextSite = siteKey.trim();
    if (nextSite !== (settings.turnstileSiteKey ?? '')) {
      // '' → efface la clé DB (fallback env alors).
      dto.turnstileSiteKey = nextSite;
    }
    if (secretKey.trim()) {
      dto.turnstileSecretKey = secretKey.trim();
    }
    if (Object.keys(dto).length === 0) {
      toast.error('Aucune clé modifiée.');
      setSavingKeys(false);
      return;
    }
    const res = await updateSecuritySettings(token, dto as never);
    setSavingKeys(false);
    if (!res.ok) { toast.error((res.data as { message?: string })?.message ?? 'Enregistrement impossible.'); return; }
    setSettings(res.data as SecuritySettings);
    setSiteKey((res.data as SecuritySettings).turnstileSiteKey ?? '');
    setSecretKey('');
    toast.ok('Clés Turnstile enregistrées.');
  }

  async function clearSiteKey() {
    if (!token) return;
    setSavingKeys(true);
    const res = await updateSecuritySettings(token, { turnstileSiteKey: '' } as never);
    setSavingKeys(false);
    if (!res.ok) { toast.error('Effacement impossible.'); return; }
    setSettings(res.data as SecuritySettings);
    setSiteKey('');
    toast.ok('Clé site effacée (retour au fallback env).');
  }

  async function clearSecretKey() {
    if (!token) return;
    setSavingKeys(true);
    const res = await updateSecuritySettings(token, { turnstileSecretKey: '' } as never);
    setSavingKeys(false);
    if (!res.ok) { toast.error('Effacement impossible.'); return; }
    setSettings(res.data as SecuritySettings);
    setSecretKey('');
    toast.ok('Clé secrète effacée.');
  }

  if (phase === 'loading' || (phase === 'ready' && !settings)) return <PageLoading label="Chargement des options de sécurité…" />;
  if (phase === 'denied' || !token) {
    return (
      <AppShell me={null} nav={ADMIN_NAV} bare={false}>
        <div className="wrap-md"><Alert tone="error" title="Accès refusé">Réservé aux administrateurs.</Alert></div>
      </AppShell>
    );
  }

  const s = settings!;
  const siteConfigured = !!s.turnstileSiteKey;
  const secretConfigured = !!s.turnstileHasSecretKey;

  return (
    <AppShell me={{ email: 'admin', role: 'ADMIN' }} nav={ADMIN_NAV}>
      <div className="wrap-md" style={ss.wrap}>
        <PageIntro
          eyebrow="Administration · Sécurité"
          title="Options de sécurité"
          sub="Chaque mesure est optionnelle. Les changements s'appliquent immédiatement."
        />
        <Alert tone="info" title="Rappel">Ces réglages contrôlent seulement quelles options sont proposées. Tout est éteint par défaut.</Alert>

        {/* ── Clés Turnstile (Phase 11) ────────────────────────────────────── */}
        <div className="panel mt">
          <div className="panel-head row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <b>Clés Cloudflare Turnstile</b>
            <div className="row" style={{ gap: 6 }}>
              <Badge tone={siteConfigured ? 'violet' : 'neutral'}>site : {siteConfigured ? 'configurée' : 'non configurée'}</Badge>
              <Badge tone={secretConfigured ? 'violet' : 'neutral'}>secret : {secretConfigured ? 'configurée' : 'non configurée'}</Badge>
            </div>
          </div>
          <div className="panel-body stack" style={{ gap: 12 }}>
            <p className="muted" style={{ fontSize: 13 }}>
              Saisissez vos clés Turnstile ici — elles sont stockées chiffrées (secret AES-256-GCM, jamais ré-exposée).
              Laissez vide pour conserver/fallback sur les variables env. Effacer avec « Effacer » revient au fallback env.
              La clé site est servie au widget client via <code>/api/public/auth-config</code>.
            </p>
            <label className="field">
              <span className="field-label">Clé site (publique, widget) — ex. <code>0x4AAA…</code></span>
              <div className="row" style={{ gap: 8 }}>
                <input className="input flex-1" placeholder="0x4AAA..." value={siteKey} onChange={(e) => setSiteKey(e.target.value)} disabled={savingKeys} style={{ minWidth: 0 }} />
                <Button variant="ghost" size="sm" onClick={clearSiteKey} disabled={savingKeys || !siteConfigured}>Effacer</Button>
              </div>
            </label>
            <label className="field">
              <span className="field-label">Clé secrète (write-only, siteverify) — laissez vide pour inchangé</span>
              <div className="row" style={{ gap: 8 }}>
                <input className="input flex-1" type="password" placeholder={secretConfigured ? '•••• vraie clé en place — saisissez pour remplacer' : '1x00000000…'} value={secretKey} onChange={(e) => setSecretKey(e.target.value)} disabled={savingKeys} style={{ minWidth: 0 }} />
                <Button variant="ghost" size="sm" onClick={clearSecretKey} disabled={savingKeys || !secretConfigured}>Effacer</Button>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>La clé secrète n&apos;est jamais ré-affichée ; on indique seulement si elle est présente.</span>
            </label>
            <div className="row" style={{ gap: 8 }}>
              <Button onClick={saveKeys} disabled={savingKeys} busy={savingKeys}>Enregistrer les clés</Button>
              <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
                Priorité : clé DB (cette page) &gt; variable env <code>TURNSTILE_*</code>.
              </span>
            </div>
          </div>
        </div>

        {/* ── Feature flags ────────────────────────────────────────────────── */}
        <div className="stack mt">
          {FLAGS.map((f) => {
            const enabled = !!s[f.key];
            return (
              <div key={f.key} className="panel">
                <div className="panel-body" style={ss.panelBody}>
                  <div className="flex-1" style={{ minWidth: 200 }}>
                    <div className="row" style={{ gap: 8 }}><b style={{ fontSize: 15 }}>{f.label}</b><Badge tone={enabled ? f.tone ?? 'ok' : 'neutral'}>{enabled ? 'Activé' : 'Désactivé'}</Badge></div>
                    <p className="muted mt-sm" style={{ fontSize: 13, maxWidth: 760 }}>{f.desc}</p>
                  </div>
                  <label className="switch">
                    <input type="checkbox" checked={enabled} disabled={busyKey === f.key} onChange={(e) => toggle(f.key, e.target.checked)} />
                    <span className="slider" aria-hidden="true" />
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt"><Button variant="secondary" onClick={load}>Actualiser</Button></div>
      </div>
    </AppShell>
  );
}
