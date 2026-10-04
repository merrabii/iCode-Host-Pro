'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { Button, PageLoading } from '@/components/ui';
import { apiError, confirmEmailChange } from '@/lib/api';

type Phase = 'loading' | 'ok' | 'error';

/**
 * GO Q3 — vérification de la NOUVELLE adresse email :
 * /auth/verifier-email?token=<jeton à usage unique>. Le jeton est lu depuis
 * l'URL côté client (window.location, comme /auth/reset) puis consommé UNE
 * seule fois : le serveur bascule User.email dans la transaction (usage unique
 * + expiration revérifiés, unicité re-sous contrainte → 409 si pris).
 * Auto-consommation au montage : cliquer le lien suffit.
 */
export default function VerifierEmailPage() {
  const router = useRouter();

  // null = URL pas encore lue ; '' = aucun jeton dans l'URL.
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false); // une seule tentative automatique

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get('token') ?? '');
  }, []);

  useEffect(() => {
    if (token === null || done) return;
    setDone(true);
    if (token === '') {
      setPhase('error');
      setError('Lien de vérification manquant ou invalide.');
      return;
    }
    (async () => {
      const res = await confirmEmailChange(token);
      if (res.ok) {
        setPhase('ok');
      } else {
        setPhase('error');
        setError(apiError(res, 'Lien de vérification invalide ou expiré.'));
      }
    })();
  }, [token, done]);

  if (phase === 'loading' && token === null) return <PageLoading label="Vérification du lien…" />;

  return (
    <AppShell me={null} nav={[]} bare>
      <div className="wrap-sm" style={{ maxWidth: 460, margin: '48px auto' }}>
        <div className="auth-card">
          <h2>Vérification de l’adresse email</h2>

          {phase === 'loading' && (
            <>
              <p>Confirmation de votre nouvelle adresse en cours…</p>
              <PageLoading label="Vérification en cours…" />
            </>
          )}

          {phase === 'ok' && (
            <>
              <div className="alert ok" role="status" style={{ fontSize: 13.5 }}>
                Nouvelle adresse email vérifiée et activée. Vos prochaines connexions
                utiliseront cette adresse.
              </div>
              <div className="auth-meta">
                <Button onClick={() => router.replace('/profil')}>Aller à mon profil</Button>
                <Button variant="secondary" onClick={() => router.replace('/auth')}>
                  Retour à la connexion
                </Button>
              </div>
            </>
          )}

          {phase === 'error' && (
            <>
              <p role="alert" className="alert error" style={{ fontSize: 13.5 }}>
                {error}
              </p>
              <div className="auth-meta">
                <Button variant="secondary" onClick={() => router.replace('/profil')}>
                  Retour au profil
                </Button>
                <Button variant="secondary" onClick={() => router.replace('/auth')}>
                  Connexion
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
