'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { useToast } from '@/components/toast';
import { Button, Field, Input } from '@/components/ui';
import { Turnstile } from '@/components/turnstile';
import { roleRank, ROLE_RANK } from '@/lib/session';
import {
  acceptInvite,
  apiError,
  fetchMe,
  getPublicAuthConfig,
  login,
  mfaConfirm,
  mfaEmailSend,
  mfaSetup,
  mfaVerify,
  register,
  type PublicAuthConfig,
} from '@/lib/api';

type Mode = 'login' | 'invite' | 'register';

export default function AuthPage() {
  const router = useRouter();
  const toast = useToast();

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  // Intent de commande (inscription à la commande) depuis /offres.
  const [productName, setProductName] = useState<string | null>(null);

  // Config publique sécurité (Turnstile / OAuth / inscription).
  const [config, setConfig] = useState<PublicAuthConfig | null>(null);

  // Étape MFA / enroll après un login.
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [methods, setMethods] = useState<string[]>([]);
  const [enrollToken, setEnrollToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaMethod, setMfaMethod] = useState<'totp' | 'email'>('totp');
  const [emailSent, setEmailSent] = useState(false);

  // Masque de mot de passe (appliqué sur les étapes du flux de connexion).
  const [busy, setBusy] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Setup TOTP lors d'un enroll forcé (politique admin).
  const [totpSecret, setTotpSecret] = useState<string | null>(null);
  const [totpUri, setTotpUri] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    const invite = params.get('invite');
    if (invite) {
      setMode('invite');
      setToken(invite);
      const inviteEmail = params.get('email');
      if (inviteEmail) setEmail(inviteEmail);
    } else if (params.get('register') === '1' || params.has('product')) {
      setMode('register');
      const prod = params.get('product');
      if (prod) setProductName(prod === '1' ? null : prod);
    }

    // Étape MFA déclenchée depuis le callback OAuth (challenge posé en cookie).
    if (params.get('oauth') === 'mfa') {
      setMode('login');
      setChallengeId('__oauth__');
    } else if (params.get('oauth') === 'enroll') {
      setMode('login');
      // Le callback OAuth ne transporte pas d'enrollToken : l'admin re-logera.
      setError('La politique MFA impose aux administrateurs d’activer la double authentification. Reconnectez-vous pour l’activer.');
    }

    const err = params.get('error');
    if (err) {
      const map: Record<string, string> = {
        oauth_missing_params: 'Réponse du fournisseur incomplète.',
        oauth_no_state: 'Jeton de sécurité OAuth absent. Réessayez.',
        oauth_bad_state: 'Jeton de sécurité OAuth invalide.',
        oauth_state_mismatch: 'Vérification d’état OAuth échouée. Réessayez.',
        oauth_exchange: 'Échange du code OAuth impossible.',
        oauth_unverified_email: 'Le fournisseur n’a pas confirmé votre email.',
        oauth_unknown_account: 'Aucun compte lié. Créez un compte lors d’une commande.',
        registration_disabled: 'L’inscription à la commande est désactivée par l’administrateur.',
        account_disabled: 'Ce compte est désactivé.',
      };
      const msg = map[err] ?? (params.get('detail') ? `Erreur : ${params.get('detail')}` : 'Échec de l’authentification.');
      toast.error(msg);
    }

    getPublicAuthConfig().then((c) => setConfig(c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gotoTarget = useCallback(
    async (accessToken: string) => {
      const me = await fetchMe(accessToken);
      const r = me ? roleRank(me.role) : -1;
      if (r >= ROLE_RANK.ADMIN) router.replace('/manager');
      else if (r >= ROLE_RANK.SUPPORT_L1) router.replace('/manager/support');
      else router.replace('/client');
    },
    [router],
  );

  function resetFlow() {
    setChallengeId(null);
    setMethods([]);
    setEnrollToken(null);
    setMfaCode('');
    setEmailSent(false);
    setTotpSecret(null);
    setTotpUri(null);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'invite') {
        const res = await acceptInvite({ token, email, password, name: name || undefined });
        if (!res.ok) throw new Error(apiError(res, 'Jeton d’invitation invalide.'));
        const data = res.data as { accessToken: string };
        toast.ok('Compte créé via invitation.');
        await gotoTarget(data.accessToken);
        return;
      }

      if (mode === 'register') {
        const res = await register({ email, password, name: name || undefined });
        if (!res.ok) throw new Error(apiError(res, 'Inscription impossible. Vérifiez que vous venez d’une commande (code produit).'));
        const data = res.data as { accessToken: string };
        toast.ok('Compte créé — votre commande est enregistrée.');
        await gotoTarget(data.accessToken);
        return;
      }

      // mode === 'login'
      const res = await login({ email, password, turnstileToken: turnstileToken || undefined });
      if (!res.ok) throw new Error(apiError(res, 'Connexion impossible.'));
      const data = res.data as
        | { accessToken: string }
        | { mfaRequired: true; challengeId: string; methods: string[] }
        | { mfaRequired: false; enroll: true; enrollToken: string };

      if ('mfaRequired' in data && data.mfaRequired) {
        setChallengeId(data.challengeId);
        setMethods(data.methods);
        setMfaMethod(data.methods.includes('totp') ? 'totp' : 'email');
        setBusy(false);
        return;
      }
      if ('mfaRequired' in data && data.enroll) {
        setEnrollToken(data.enrollToken);
        setBusy(false);
        return;
      }
      setTurnstileToken('');
      toast.ok('Connecté.');
      await gotoTarget((data as { accessToken: string }).accessToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function submitMfa() {
    if (!challengeId || challengeId === '__oauth__') return;
    if (!mfaCode.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await mfaVerify({ challengeId, code: mfaCode.trim(), method: mfaMethod });
      if (!res.ok) throw new Error(apiError(res, 'Code invalide ou session expirée.'));
      const data = res.data as { accessToken: string };
      toast.ok('Vérification OK.');
      await gotoTarget(data.accessToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function sendEmailOtp() {
    if (!challengeId || challengeId === '__oauth__') return;
    setBusy(true);
    setError(null);
    try {
      const res = await mfaEmailSend(challengeId);
      if (!res.ok) throw new Error(apiError(res, 'Envoi du code par email impossible.'));
      setEmailSent(true);
      toast.ok('Code envoyé par email.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startEnroll() {
    if (!enrollToken) return;
    setBusy(true);
    setError(null);
    try {
      const res = await mfaSetup(enrollToken, password);
      if (!res.ok) throw new Error(apiError(res, 'Impossible de préparer la double authentification.'));
      const d = res.data as { secret: string; uri: string };
      setTotpSecret(d.secret);
      setTotpUri(d.uri);
      toast.info('Scannez le code QR puis validez avec un premier code.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll() {
    if (!enrollToken || !mfaCode.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await mfaConfirm(enrollToken, mfaCode.trim());
      if (!res.ok) throw new Error(apiError(res, 'Code invalide.'));
      resetFlow();
      toast.ok('Double authentification activée. Reconnectez-vous.');
      setMode('login');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // ── Vue : étape MFA (2ᵉ facteur) ──────────────────────────────────────────
  if (challengeId) {
    return (
      <Shell>
        <div className="auth-card">
          <h2>Double authentification</h2>
          <p>Entrez le code à 6 chiffres pour terminer la connexion.</p>
          {methods.length > 1 && (
            <div className="row">
              <Button
                variant={mfaMethod === 'totp' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => {
                  setMfaMethod('totp');
                  setEmailSent(false);
                }}
              >
                Application d’authentification
              </Button>
              <Button
                variant={mfaMethod === 'email' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => {
                  setMfaMethod('email');
                  setEmailSent(false);
                }}
              >
                Code par email
              </Button>
            </div>
          )}
          {mfaMethod === 'email' && (
            <div className="mt-sm">
              {!emailSent ? (
                <Button variant="secondary" onClick={sendEmailOtp} disabled={busy}>
                  Envoyer le code par email
                </Button>
              ) : (
                <p className="muted" style={{ fontSize: 13 }}>
                  Code envoyé — vérifiez votre boîte email.
                </p>
              )}
            </div>
          )}
          <form
            className="auth-form mt"
            onSubmit={(e) => {
              e.preventDefault();
              submitMfa();
            }}
          >
            <Field label="Code" required>
              <Input
                inputMode="numeric"
                maxLength={6}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                className="input-mono"
                autoFocus
              />
            </Field>
            {error && <ErrorMsg>{error}</ErrorMsg>}
            <Button type="submit" disabled={busy || !mfaCode.trim()}>
              Vérifier
            </Button>
          </form>
          <div className="auth-meta">
            <Button variant="secondary" onClick={() => { resetFlow(); setMode('login'); }}>
              Retour à la connexion
            </Button>
          </div>
        </div>
      </Shell>
    );
  }

  // ── Vue : activation MFA (politique admin, enrollToken fourni) ────────────
  if (enrollToken) {
    return (
      <Shell>
        <div className="auth-card">
          <h2>Activez votre double authentification</h2>
          <p>
            La politique de sécurité exige qu’un administrateur active la double authentification
            avant de se connecter. Utilisez une application comme Google Authenticator, Authy ou
            1Password.
          </p>
          {!totpSecret ? (
            <>
              {error && <ErrorMsg>{error}</ErrorMsg>}
              <div className="mt">
                <Button onClick={startEnroll} disabled={busy}>
                  Préparer mon code QR
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="mt">
                {totpUri && (
                  <>
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(totpUri)}`}
                      alt="QR code d’enrôlement TOTP"
                      width={180}
                      height={180}
                      style={{ borderRadius: 10, border: '1px solid var(--border-soft)' }}
                    />
                    <details className="mt-sm" open={false}>
                      <summary className="muted" style={{ fontSize: 13 }}>
                        Clé secrète (saisie manuelle)
                      </summary>
                      <code className="input-mono mt-sm" style={{ display: 'block', padding: 8 }}>
                        {totpSecret}
                      </code>
                    </details>
                  </>
                )}
              </div>
              <form
                className="auth-form mt"
                onSubmit={(e) => {
                  e.preventDefault();
                  confirmEnroll();
                }}
              >
                <Field label="Premier code (6 chiffres)" required>
                  <Input
                    inputMode="numeric"
                    maxLength={6}
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    className="input-mono"
                  />
                </Field>
                {error && <ErrorMsg>{error}</ErrorMsg>}
                <Button type="submit" disabled={busy || !mfaCode.trim()}>
                  Activer
                </Button>
              </form>
            </>
          )}
        </div>
      </Shell>
    );
  }

  // ── Vue principale : login / invite / register ────────────────────────────
  return (
    <Shell>
      <div className="auth-card">
        <h2>
          {mode === 'login' ? 'Connexion' : mode === 'register' ? 'Créer un compte pour commander' : 'Accepter l’invitation'}
        </h2>
        <p>
          {mode === 'login' && 'Accédez à votre espace client et à la console de gestion.'}
          {mode === 'register' &&
            (productName
              ? `Compte créé au moment de votre commande du produit « ${productName} ».`
              : 'Compte créé au moment de passer commande. L’inscription libre reste fermée.')}
          {mode === 'invite' && 'Un compte se crée uniquement par invitation (ADR-020).'}
        </p>

        {/* Boutons OAuth — visibles seulement si le fournisseur est activé. */}
        {mode !== 'invite' && (config?.oauthGoogleEnabled || config?.oauthGithubEnabled) && (
          <div className="auth-oauth">
            {config.oauthGoogleEnabled && (
              <a className="btn-secondary btn-oauth" href="/api/auth/oauth/google">
                <span className="oauth-glyph oauth-g">G</span>
                Continuer avec Google
              </a>
            )}
            {config.oauthGithubEnabled && (
              <a className="btn-secondary btn-oauth" href={mode === 'register' ? '/api/auth/oauth/github' : '/api/auth/oauth/github'}>
                <span className="oauth-glyph oauth-gh">GH</span>
                Continuer avec GitHub
              </a>
            )}
          </div>
        )}

        {mode !== 'invite' && (config?.oauthGoogleEnabled || config?.oauthGithubEnabled) && (
          <div className="auth-divider">
            <span>ou</span>
          </div>
        )}

        <form className="auth-form" onSubmit={submit}>
          {mode === 'invite' && (
            <Field label="Jeton d’invitation (rempli depuis le lien reçu)" required>
              <Input value={token} onChange={(e) => setToken(e.target.value)} className="input-mono" />
            </Field>
          )}
          <Field label="Email" required>
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {mode !== 'login' && (
            <Field label="Nom (optionnel)">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
          <Field label="Mot de passe" required>
            <Input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {config?.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onChange={setTurnstileToken} />}
          {error && <ErrorMsg>{error}</ErrorMsg>}
          <Button type="submit" disabled={busy}>
            {mode === 'login' ? 'Connexion' : mode === 'register' ? 'Créer mon compte & passer la commande' : 'Créer mon compte'}
          </Button>
        </form>

        <div className="auth-meta">
          {mode === 'login' && (
            <Button variant="secondary" onClick={() => { setMode('invite'); resetFlow(); }}>
              J’ai une invitation — accepter un jeton
            </Button>
          )}
          {mode === 'invite' && (
            <Button variant="secondary" onClick={() => { setMode('login'); resetFlow(); }}>
              J’ai déjà un compte — se connecter
            </Button>
          )}
          {(mode === 'login' || mode === 'invite') && (
            <Button variant="secondary" onClick={() => { setMode('register'); resetFlow(); }}>
              Je viens d’une commande & je n’ai pas de compte
            </Button>
          )}
          {mode === 'register' && (
            <Button variant="secondary" onClick={() => { setMode('login'); resetFlow(); }}>
              J’ai déjà un compte — se connecter
            </Button>
          )}
          <a className="btn-secondary btn-oauth" href="/offres" style={{ justifyContent: 'center' }}>
            Consulter le catalogue & commander
          </a>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell me={null} nav={[]} bare>
      <div className="wrap-sm">{children}</div>
    </AppShell>
  );
}

function ErrorMsg({ children }: { children: React.ReactNode }) {
  return <div className="alert error" style={{ fontSize: 13.5 }}>{children}</div>;
}