'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { useToast } from '@/components/toast';
import { Button, Field, Input } from '@/components/ui';
import { Turnstile } from '@/components/turnstile';
import { TotpQr } from '@/components/totp-qr';
import { useBrand } from '@/components/brand-provider';
import { IconCheck, IconServer, IconShield, IconUsers } from '@/components/icons';
import { roleRank, ROLE_RANK } from '@/lib/session';
import {
  acceptInvite,
  apiError,
  fetchMe,
  freeSignup,
  getPublicAuthConfig,
  login,
  mfaConfirm,
  mfaEmailSend,
  mfaSetup,
  mfaVerify,
  register,
  type PublicAuthConfig,
} from '@/lib/api';

type Mode = 'login' | 'invite' | 'register' | 'free';

/** Validation d'email (mêmes règles que le champ natif type=email). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Longueur minimale de mot de passe (identique à l'attribut minLength). */
const PASSWORD_MIN = 8;

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
  // Phase 16 — inscription autonome du Plan Gratuit (`?plan=<slug>`, sans checkout).
  const [freeSlug, setFreeSlug] = useState<string | null>(null);

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
  // Erreurs de saisie associées aux champs (aria-describedby / aria-invalid).
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; token?: string }>({});
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
    } else if (params.get('plan')) {
      // Phase 16 — Plan Gratuit : inscription autonome, PAS d'ordre/paiement.
      const slug = params.get('plan') as string;
      setFreeSlug(slug);
      setMode('free');
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
      // Affiché inline dans la carte (role=alert) — même pattern que les
      // erreurs de soumission, pour rester visible et accessible.
      setError(msg);
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
    setFieldErrors({});
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Validation de saisie (identique aux attributs natifs) → erreurs
    // associées au champ, sans appel réseau si invalide.
    const fe: { email?: string; password?: string; token?: string } = {};
    if (!EMAIL_RE.test(email.trim())) fe.email = 'Saisissez une adresse email valide.';
    if (password.length < PASSWORD_MIN) fe.password = `Mot de passe : ${PASSWORD_MIN} caractères minimum.`;
    if (mode === 'invite' && !token.trim()) fe.token = 'Collez le jeton d’invitation reçu.';
    if (fe.email || fe.password || fe.token) {
      setFieldErrors(fe);
      return;
    }
    setFieldErrors({});

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

      if (mode === 'free') {
        const res = await freeSignup({ email, password, name: name || undefined, planSlug: freeSlug ?? undefined });
        if (!res.ok) throw new Error(apiError(res, 'Inscription au Plan Gratuit impossible.'));
        const data = res.data as { accessToken: string };
        toast.ok('Bienvenue ! Votre Plan Gratuit est actif.');
        router.replace('/client?free=ok');
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
            <Field label="Code" htmlFor="auth-mfa" required>
              <Input
                id="auth-mfa"
                inputMode="numeric"
                maxLength={6}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                className="input-mono"
                autoFocus
              />
            </Field>
            {error && <ErrorMsg>{error}</ErrorMsg>}
            <Button type="submit" busy={busy} disabled={busy || !mfaCode.trim()}>
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
            <Button onClick={startEnroll} busy={busy} disabled={busy}>
              Préparer mon code QR
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="mt">
            {totpUri && (
              <>
                <TotpQr uri={totpUri} />
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
                <Field label="Premier code (6 chiffres)" htmlFor="auth-enroll-code" required>
                  <Input
                    id="auth-enroll-code"
                    inputMode="numeric"
                    maxLength={6}
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    className="input-mono"
                  />
                </Field>
                {error && <ErrorMsg>{error}</ErrorMsg>}
                <Button type="submit" busy={busy} disabled={busy || !mfaCode.trim()}>
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
          {mode === 'login'
            ? 'Connexion'
            : mode === 'register'
              ? 'Créer un compte pour commander'
              : mode === 'free'
                ? 'Commencez gratuitement'
                : 'Accepter l’invitation'}
        </h2>
        <p>
          {mode === 'login' && 'Accédez à votre espace client et à la console de gestion.'}
          {mode === 'register' &&
            (productName
              ? `Compte créé au moment de votre commande du produit « ${productName} ».`
              : 'Compte créé au moment de passer commande. L’inscription libre reste fermée.')}
          {mode === 'free' &&
            'Créez votre compte gratuitement — aucune carte requise. Vous pourrez déployer votre premier projet immédiatement.'}
          {mode === 'invite' && 'Un compte se crée uniquement par invitation (ADR-020).'}
        </p>

        {/* Boutons OAuth — visibles seulement si le fournisseur est activé. */}
        {mode !== 'invite' && (config?.oauthGoogleEnabled || config?.oauthGithubEnabled) && (
          <div className="auth-oauth">
            {config.oauthGoogleEnabled && (
              <a
                className="btn-secondary btn-oauth"
                href={mode === 'free' ? `/api/auth/oauth/google?mode=free&plan=${encodeURIComponent(freeSlug ?? '')}` : '/api/auth/oauth/google'}
              >
                <span className="oauth-glyph oauth-g">G</span>
                Continuer avec Google
              </a>
            )}
            {config.oauthGithubEnabled && (
              <a
                className="btn-secondary btn-oauth"
                href={mode === 'free' ? `/api/auth/oauth/github?mode=free&plan=${encodeURIComponent(freeSlug ?? '')}` : '/api/auth/oauth/github'}
              >
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

        {/* noValidate : validation gérée ci-dessous → erreurs inline accessibles
            (role=alert, aria-invalid) au lieu des infobulles natives non
            présentes dans le DOM. Les attributs required/minLength restent en
            place pour la sémantique. */}
        <form className="auth-form" onSubmit={submit} noValidate>
          {mode === 'invite' && (
            <Field label="Jeton d’invitation (rempli depuis le lien reçu)" htmlFor="auth-token" required>
              <>
                <Input
                  id="auth-token"
                  value={token}
                  aria-invalid={fieldErrors.token ? true : undefined}
                  aria-describedby={fieldErrors.token ? 'auth-token-err' : undefined}
                  onChange={(e) => {
                    setToken(e.target.value);
                    if (fieldErrors.token) setFieldErrors((f) => ({ ...f, token: undefined }));
                  }}
                  className="input-mono"
                />
                {fieldErrors.token && (
                  <span className="field-error" id="auth-token-err" role="alert">{fieldErrors.token}</span>
                )}
              </>
            </Field>
          )}
          <Field label="Email" htmlFor="auth-email" required>
            <>
              <Input
                id="auth-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                aria-invalid={fieldErrors.email ? true : undefined}
                aria-describedby={fieldErrors.email ? 'auth-email-err' : undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (fieldErrors.email) setFieldErrors((f) => ({ ...f, email: undefined }));
                }}
              />
              {fieldErrors.email && (
                <span className="field-error" id="auth-email-err" role="alert">{fieldErrors.email}</span>
              )}
            </>
          </Field>
          {mode !== 'login' && (
            <Field label="Nom (optionnel)" htmlFor="auth-name">
              <Input id="auth-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
          <Field label="Mot de passe" htmlFor="auth-password" required>
            <>
              <Input
                id="auth-password"
                type="password"
                required
                minLength={PASSWORD_MIN}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={fieldErrors.password ? 'auth-password-err' : undefined}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
                }}
              />
              {fieldErrors.password && (
                <span className="field-error" id="auth-password-err" role="alert">{fieldErrors.password}</span>
              )}
            </>
          </Field>
          {config?.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onChange={setTurnstileToken} />}
          {error && <ErrorMsg>{error}</ErrorMsg>}
          <Button type="submit" busy={busy} disabled={busy}>
            {mode === 'login'
              ? 'Connexion'
              : mode === 'register'
                ? 'Créer mon compte & passer la commande'
                : mode === 'free'
                  ? 'Commencez gratuitement — créer mon compte'
                  : 'Créer mon compte'}
          </Button>
        </form>

        {/* Hiérarchie : une action secondaire principale + liens discrets. */}
        <div className="auth-meta">
          {mode === 'login' && (
            <Button variant="secondary" onClick={() => { setMode('register'); resetFlow(); }}>
              Créer un compte
            </Button>
          )}
          {(mode === 'register' || mode === 'invite' || mode === 'free') && (
            <Button variant="secondary" onClick={() => { setMode('login'); resetFlow(); }}>
              Se connecter
            </Button>
          )}
          {mode === 'login' && (
            <button type="button" className="auth-link" onClick={() => { setMode('invite'); resetFlow(); }}>
              J’ai une invitation — accepter un jeton
            </button>
          )}
          <a className="auth-link" href="/shop">
            Consulter le catalogue &amp; commander
          </a>
        </div>
      </div>
    </Shell>
  );
}

const AUTH_POINTS = [
  { icon: IconServer, text: 'Déployez depuis GitHub vers votre serveur en un clic' },
  { icon: IconShield, text: 'Sécurité configurable : Turnstile, OAuth, double authentification' },
  { icon: IconUsers, text: 'Support escaladable et centre d’aide à jour' },
];

function Shell({ children }: { children: React.ReactNode }) {
  const { brand } = useBrand();
  return (
    <AppShell me={null} nav={[]} bare>
      <div className="auth-split">
        <aside className="auth-aside">
          <span className="landing-chip">
            <span className="landing-chip-dot" />
            Console d’hébergement
          </span>
          <h2 className="auth-aside-title">
            Tout votre hébergement, <span className="landing-gradient">un seul compte.</span>
          </h2>
          <p className="auth-aside-sub">
            Commandez un service, déployez vos applications et suivez vos serveurs —
            connectez-vous ou créez votre compte en quelques secondes.
          </p>
          <ul className="auth-aside-points">
            {AUTH_POINTS.map((p) => (
              <li key={p.text}>
                <span className="offres-perk-check"><p.icon size={13} /></span>
                {p.text}
              </li>
            ))}
          </ul>
          <div className="auth-aside-foot">
            <span className="pill-tag"><span className="dot" /> {brand.tagline}</span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Plateforme sécurisée · données chiffrées au repos
            </span>
          </div>
        </aside>
        <div className="auth-stage">{children}</div>
      </div>
    </AppShell>
  );
}

function ErrorMsg({ children }: { children: React.ReactNode }) {
  return <div className="alert error" role="alert" style={{ fontSize: 13.5, marginBottom: 0 }}>{children}</div>;
}