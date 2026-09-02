'use client';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, Field, Input, PageIntro, PageLoading } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useAnySession } from '@/lib/session';
import {
  changePassword,
  decodeJwt,
  getSupportCodeStatus,
  getPublicAuthConfig,
  mfaConfirm,
  mfaDisable,
  mfaSetup,
  oauthUnlink,
  type PublicAuthConfig,
} from '@/lib/api';

export default function ProfilPage() {
  const toast = useToast();
  const { phase, me, token } = useAnySession();

  const [config, setConfig] = useState<PublicAuthConfig | null>(null);
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);

  // MFA setup
  const [pw, setPw] = useState('');
  const [mfaSecret, setMfaSecret] = useState<string | null>(null);
  const [mfaUri, setMfaUri] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  // MFA disable
  const [disablePw, setDisablePw] = useState('');
  const [disableCode, setDisableCode] = useState('');
  // Password change
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  // Support code status
  const [hasCode, setHasCode] = useState(false);

  // Query feedback after an OAuth link round-trip (?linked=google&?conflict=…).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get('linked');
    if (linked) toast.ok(`Fournisseur ${linked} lié à votre compte.`);
    const conflict = params.get('link');
    if (conflict === 'conflict') toast.error('Impossible de lier ce fournisseur : déjà relié à un autre compte.');
    const cl = params.get('link');
    if (!linked && !conflict && cl) toast.error('Liaison impossible.');
    getPublicAuthConfig().then((c) => setConfig(c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // En session d'impersonation, la consultation est en lecture seule.
  const canEdit = useMemo(() => {
    if (!token) return false;
    const decoded = decodeJwt(token);
    return !decoded?.imp;
  }, [token]);

  useEffect(() => {
    if (me) setMfaEnabled(!!me.mfaEnabled);
  }, [me]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      const res = await getSupportCodeStatus(token);
      if (res.ok) {
        const d = res.data as { active: boolean };
        setHasCode(!!d.active);
      }
    })();
  }, [token]);

  if (phase === 'loading') return <PageLoading label="Chargement du profil…" />;
  if (phase === 'denied' || !me || !token) {
    return (
      <AppShell me={null} nav={[]} bare>
        <div className="wrap-sm">
          <Alert tone="error" title="Accès refusé">Authentification requise.</Alert>
        </div>
      </AppShell>
    );
  }

  const linked = [
    ...(me.oauthProvider === 'google' ? ['google'] : []),
    ...(me.oauthProvider === 'github' ? ['github'] : []),
  ];

  async function startMfa() {
    if (!pw) return;
    const res = await mfaSetup(token, pw);
    if (!res.ok) {
      toast.error((res.data as { message?: string })?.message ?? 'Échec de la préparation MFA.');
      return;
    }
    const d = res.data as { secret: string; uri: string };
    setMfaSecret(d.secret);
    setMfaUri(d.uri);
    toast.info('Scannez le QR puis validez avec un premier code.');
  }

  async function confirmMfa() {
    if (!mfaCode.trim()) return;
    const res = await mfaConfirm(token, mfaCode.trim());
    if (!res.ok) {
      toast.error((res.data as { message?: string })?.message ?? 'Code invalide.');
      return;
    }
    setMfaEnabled(true);
    setMfaSecret(null);
    setMfaUri(null);
    setMfaCode('');
    setPw('');
    toast.ok('Double authentification activée.');
  }

  async function disableMfa() {
    if (!disablePw || !disableCode.trim()) return;
    const res = await mfaDisable(token, disablePw, disableCode.trim());
    if (!res.ok) {
      toast.error((res.data as { message?: string })?.message ?? 'Désactivation impossible.');
      return;
    }
    setMfaEnabled(false);
    setDisablePw('');
    setDisableCode('');
    toast.ok('Double authentification désactivée.');
  }

  async function savePassword() {
    if (!curPw || newPw.length < 8) {
      toast.error('Le nouveau mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    const res = await changePassword(token, curPw, newPw);
    if (!res.ok) {
      toast.error((res.data as { message?: string })?.message ?? 'Changement de mot de passe impossible.');
      return;
    }
    setCurPw('');
    setNewPw('');
    toast.ok('Mot de passe modifié.');
  }

  async function unlink(provider: 'google' | 'github') {
    const res = await oauthUnlink(token, provider);
    if (!res.ok) {
      toast.error((res.data as { message?: string })?.message ?? 'Déliaison impossible.');
      return;
    }
    toast.ok(`Fournisseur ${provider} délié.`);
    // Recharge le profil pour refléter l'état.
    window.location.reload();
  }

  const PROVIDERS: { id: 'google' | 'github'; label: string }[] = [
    { id: 'google', label: 'Google' },
    { id: 'github', label: 'GitHub' },
  ];

  return (
    <AppShell me={me} nav={[]} bare={false}>
      <div className="wrap-md">
        <PageIntro
          eyebrow="Mon profil"
          title="Compte & sécurité"
          sub="Gérez votre double authentification, vos comptes liés (Google / GitHub) et votre mot de passe."
        />

        {!canEdit && (
          <Alert tone="warn" title="Session de consultation">
            Vous consultez ce profil en tant que support (lecture seule). La modification est désactivée.
          </Alert>
        )}

        <div className="grid">
          {/* Identité */}
          <div className="panel">
            <div className="panel-head">
              <div className="flex-1">
                <div className="panel-title">{me.name || me.email}</div>
                <div className="panel-sub">{me.email}</div>
              </div>
              <Badge>{me.role}</Badge>
            </div>
            <div className="panel-body stack">
              <div>
                <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
                  Double authentification
                </div>
                <Badge tone={mfaEnabled ? 'ok' : 'neutral'}>{mfaEnabled ? 'Activée' : 'Désactivée'}</Badge>
              </div>
              <div>
                <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
                  Comptes liés
                </div>
                <div className="row">
                  {linked.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Aucun fournisseur lié.</span>}
                  {linked.map((p) => (
                    <Badge key={p} tone="info">{p}</Badge>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* MFA */}
          <div className="panel">
            <div className="panel-head">
              <div className="flex-1">
                <div className="panel-title">Double authentification</div>
                <div className="panel-sub">Application TOTP · code à 6 chiffres.</div>
              </div>
            </div>
            <div className="panel-body stack">
              {!mfaEnabled ? (
                !mfaSecret ? (
                  <>
                    <Field label="Mot de passe actuel" required>
                      <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} disabled={!canEdit} />
                    </Field>
                    <Button onClick={startMfa} disabled={!canEdit || !pw}>Activer avec une application</Button>
                  </>
                ) : (
                  <>
                    {mfaUri && (
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=170x170&data=${encodeURIComponent(mfaUri)}`}
                        alt="QR code TOTP"
                        width={170}
                        height={170}
                        style={{ borderRadius: 10, border: '1px solid var(--border-soft)' }}
                      />
                    )}
                    <details>
                      <summary className="muted" style={{ fontSize: 13 }}>Clé secrète (saisie manuelle)</summary>
                      <code className="input-mono mt-sm" style={{ display: 'block', padding: 8 }}>{mfaSecret}</code>
                    </details>
                    <Field label="Premier code (6 chiffres)" required>
                      <Input inputMode="numeric" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} className="input-mono" />
                    </Field>
                    <div className="row">
                      <Button onClick={confirmMfa} disabled={!mfaCode.trim()}>Valider</Button>
                      <Button variant="secondary" onClick={() => { setMfaSecret(null); setMfaUri(null); setMfaCode(''); }}>Annuler</Button>
                    </div>
                  </>
                )
              ) : (
                <div className="stack">
                  <Alert tone="ok" title="MFA active">Vos codes de connexion sont protégés.</Alert>
                  <Field label="Mot de passe" required>
                    <Input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} disabled={!canEdit} />
                  </Field>
                  <Field label="Code actuel (6 chiffres)" required>
                    <Input inputMode="numeric" maxLength={6} value={disableCode} onChange={(e) => setDisableCode(e.target.value)} className="input-mono" disabled={!canEdit} />
                  </Field>
                  <Button variant="danger" onClick={disableMfa} disabled={!canEdit || !disablePw || !disableCode.trim()}>
                    Désactiver
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Fournisseurs liés */}
          <div className="panel">
            <div className="panel-head">
              <div className="flex-1">
                <div className="panel-title">Comptes liés</div>
                <div className="panel-sub">Connectez-vous plus vite via Google ou GitHub.</div>
              </div>
            </div>
            <div className="panel-body stack">
              {PROVIDERS.map((p) => {
                const isLinked = linked.includes(p.id);
                const enabled = p.id === 'google' ? config?.oauthGoogleEnabled : config?.oauthGithubEnabled;
                return (
                  <div key={p.id} className="row" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <b style={{ fontSize: 14 }}>{p.label}</b>
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        {isLinked ? 'Lié' : 'Non lié'}
                      </div>
                    </div>
                    <div className="row">
                      {!isLinked ? (
                        enabled ? (
                          <a className="btn-secondary btn-sm" href={`/api/auth/oauth/link/${p.id}`}>
                            Lier
                          </a>
                        ) : (
                          <span className="muted" style={{ fontSize: 12.5 }}>Désactivé</span>
                        )
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => unlink(p.id)} disabled={!canEdit}>
                          Délier
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Mot de passe */}
          <div className="panel">
            <div className="panel-head">
              <div className="flex-1">
                <div className="panel-title">Mot de passe</div>
                <div className="panel-sub">Minimum 8 caractères.</div>
              </div>
            </div>
            <div className="panel-body stack">
              <Field label="Mot de passe actuel" required>
                <Input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} disabled={!canEdit} />
              </Field>
              <Field label="Nouveau mot de passe" required>
                <Input type="password" minLength={8} value={newPw} onChange={(e) => setNewPw(e.target.value)} disabled={!canEdit} />
              </Field>
              <Button onClick={savePassword} disabled={!canEdit}>Changer le mot de passe</Button>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}