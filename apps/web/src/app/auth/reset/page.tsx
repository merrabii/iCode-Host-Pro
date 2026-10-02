'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { Button, Field, Input, PageLoading } from '@/components/ui';
import { apiError, resetPassword } from '@/lib/api';

const PASSWORD_MIN = 8;

/**
 * GO socle (lot A1) — consommation du lien « mot de passe oublié » reçu par
 * email : /auth/reset?token=<jeton à usage unique>. Le jeton est lu depuis
 * l'URL côté client (window.location, pas de hook searchParams → pas de
 * boundary Suspense à gérer) et envoyé au serveur qui valide usage unique +
 * expiration. En succès : retour /auth?reset=done (toast de confirmation).
 */
export default function AuthResetPage() {
  const router = useRouter();

  // null = URL pas encore lue ; '' = aucun jeton dans l'URL.
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get('token') ?? '');
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < PASSWORD_MIN) {
      setError(`Le nouveau mot de passe doit contenir au moins ${PASSWORD_MIN} caractères.`);
      return;
    }
    if (password !== confirm) {
      setError('Les deux mots de passe ne correspondent pas.');
      return;
    }
    setBusy(true);
    try {
      const res = await resetPassword(token ?? '', password);
      if (!res.ok) {
        setError(apiError(res, 'Lien de réinitialisation invalide ou expiré.'));
        return;
      }
      router.replace('/auth?reset=done');
    } finally {
      setBusy(false);
    }
  }

  if (token === null) return <PageLoading label="Vérification du lien…" />;

  return (
    <AppShell me={null} nav={[]} bare>
      <div className="wrap-sm" style={{ maxWidth: 460, margin: '48px auto' }}>
        <div className="auth-card">
          <h2>Nouveau mot de passe</h2>
          {token === '' ? (
            <>
              <p role="alert" className="alert error" style={{ fontSize: 13.5 }}>
                Lien de réinitialisation manquant ou invalide. Relancez une demande depuis la page de connexion.
              </p>
              <div className="auth-meta">
                <Button variant="secondary" onClick={() => router.replace('/auth')}>
                  Retour à la connexion
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>Choisissez un nouveau mot de passe pour votre compte. Le lien ne fonctionne qu’une seule fois.</p>
              <form className="auth-form" onSubmit={submit} noValidate>
                <Field label="Nouveau mot de passe" htmlFor="reset-password" required>
                  <Input
                    id="reset-password"
                    type="password"
                    required
                    minLength={PASSWORD_MIN}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Field label="Confirmer le mot de passe" htmlFor="reset-confirm" required>
                  <Input
                    id="reset-confirm"
                    type="password"
                    required
                    minLength={PASSWORD_MIN}
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </Field>
                {error && (
                  <div className="alert error" role="alert" style={{ fontSize: 13.5, marginBottom: 0 }}>
                    {error}
                  </div>
                )}
                <Button type="submit" busy={busy} disabled={busy}>
                  Enregistrer le nouveau mot de passe
                </Button>
              </form>
              <div className="auth-meta">
                <Button variant="secondary" onClick={() => router.replace('/auth')}>
                  Retour à la connexion
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
