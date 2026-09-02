'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, PageIntro, PageLoading } from '@/components/ui';
import { useToast } from '@/components/toast';
import { ADMIN_NAV } from '@/config/nav';
import { useAdminSession } from '@/lib/session';
import {
  getSecuritySettings,
  updateSecuritySettings,
  type SecuritySettings,
} from '@/lib/api';

interface FlagDef {
  key: keyof SecuritySettings;
  label: string;
  desc: string;
  tone?: 'ok' | 'warn' | 'info' | 'violet';
}

const FLAGS: FlagDef[] = [
  {
    key: 'turnstileEnabled',
    label: 'Cloudflare Turnstile',
    desc: 'Anti-bot sur le login. Effectif seulement si une clé site + clé secret Turnstile sont configurées.',
    tone: 'violet',
  },
  {
    key: 'oauthGoogleEnabled',
    label: 'Connexion Google',
    desc: 'Bouton « Continuer avec Google » (login, liaison et inscription à la commande). Nécessite les clés client Google.',
    tone: 'info',
  },
  {
    key: 'oauthGithubEnabled',
    label: 'Connexion GitHub',
    desc: 'Bouton « Continuer avec GitHub ». Nécessite les clés client GitHub.',
    tone: 'info',
  },
  {
    key: 'mfaRequiredForAdmins',
    label: 'MFA obligatoire pour les admins',
    desc: "Un administrateur sans double authentification est invité à l'activer (avec son mot de passe) avant de se connecter.",
    tone: 'ok',
  },
  {
    key: 'selfRegistrationEnabled',
    label: 'Inscription à la commande',
    desc: "Autorise la création d'un compte au moment de passer commande (Google / GitHub / email + mot de passe). L'inscription libre reste fermée.",
    tone: 'warn',
  },
  {
    key: 'deployEnabled',
    label: 'Déploiements GitHub → Coolify',
    desc: "Active l'autodétection des dépôts GitHub et le déploiement sur le serveur Coolify connecté (Phase 10bis).",
    tone: 'violet',
  },
];

export default function SecuritePage() {
  const toast = useToast();
  const { phase, token } = useAdminSession();
  const [settings, setSettings] = useState<SecuritySettings | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await getSecuritySettings(token);
    if (res.ok) setSettings(res.data as SecuritySettings);
    else toast.error((res.data as { message?: string })?.message ?? 'Lecture des options impossible.');
  }, [token, toast]);

  useEffect(() => {
    if (phase === 'ready') load();
  }, [phase, load]);

  async function toggle(key: keyof SecuritySettings, value: boolean) {
    if (!token) return;
    setBusyKey(key);
    const res = await updateSecuritySettings(token, { [key]: value } as Partial<SecuritySettings>);
    setBusyKey(null);
    if (!res.ok) {
      toast.error((res.data as { message?: string })?.message ?? 'Mise à jour impossible.');
      load();
      return;
    }
    setSettings(res.data as SecuritySettings);
    toast.ok('Option mise à jour.');
  }

  if (phase === 'loading' || (phase === 'ready' && !settings)) {
    return <PageLoading label="Chargement des options de sécurité…" />;
  }
  if (phase === 'denied' || !token) {
    return (
      <AppShell me={null} nav={ADMIN_NAV} bare={false}>
        <div className="wrap-md">
          <Alert tone="error" title="Accès refusé">Réservé aux administrateurs.</Alert>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell me={{ email: 'admin', role: 'ADMIN' }} nav={ADMIN_NAV}>
      <div className="wrap-md">
        <PageIntro
          eyebrow="Administration · Sécurité"
          title="Options de sécurité"
          sub="Chaque mesure est non obligatoire : activez ou relaxez selon votre politique. Les changements s'appliquent immédiatement."
        />

        <Alert tone="info" title="Rappel">
          <span>
            Ces réglages ne suppriment jamais les mesures de sécurité déjà actives pour l&apos;authentification —
            ils contrôlent seulement quelles options sont proposées (Tout est éteint par défaut).
          </span>
        </Alert>

        <div className="stack mt">
          {FLAGS.map((f) => {
            const enabled = !!settings?.[f.key];
            return (
              <div key={f.key} className="panel">
                <div className="panel-body row" style={{ justifyContent: 'space-between' }}>
                  <div className="flex-1">
                    <div className="row" style={{ gap: 8 }}>
                      <b style={{ fontSize: 15 }}>{f.label}</b>
                      <Badge tone={enabled ? f.tone ?? 'ok' : 'neutral'}>{enabled ? 'Activé' : 'Désactivé'}</Badge>
                    </div>
                    <p className="muted mt-sm" style={{ fontSize: 13, maxWidth: 760 }}>
                      {f.desc}
                    </p>
                  </div>
                  <div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={busyKey === f.key}
                        onChange={(e) => toggle(f.key, e.target.checked)}
                      />
                      <span className="slider" aria-hidden="true" />
                    </label>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt">
          <Button variant="secondary" onClick={load}>Actualiser</Button>
        </div>
      </div>
    </AppShell>
  );
}