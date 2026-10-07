'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  apiError,
  CARD_PAYMENT_LABEL,
  CARD_PAYMENT_TONE,
  fetchMe,
  formatCents,
  getMyCardTopup,
  getSessionToken,
  refreshMyCardTopup,
  type CardTopup,
  type Me,
} from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { CLIENT_NAV } from '@/config/nav';
import { useToast } from '@/components/toast';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  PageIntro,
  PageLoading,
  Panel,
} from '@/components/ui';

type Phase = 'loading' | 'denied' | 'ready';

/** Statuts pour lesquels le serveur peut encore progresser (poll de relecture). */
const ACTIVE: string[] = ['CREATED', 'PROCESSING'];

/**
 * GO Stripe §7 — état d'une recharge par carte APRÈS la page hébergée.
 *
 * Le navigateur n'affirme RIEN : chaque rafraîchissement demande au serveur de
 * relire le prestataire (webhook signé = chemin normal ; relecture = repli
 * lorsque le prestataire ne peut pas joindre le recette). Les états
 * refusé/annulé/expiré/remboursé/intervention sont affichés explicitement.
 */
function PaymentStatusContent() {
  const router = useRouter();
  const toast = useToast();
  const params = useSearchParams();
  const reference = params.get('ref') ?? '';
  const canceled = params.get('canceled') === '1';

  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [topup, setTopup] = useState<CardTopup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const polls = useRef(0);

  const load = useCallback(
    async (t: string, refresh: boolean) => {
      if (!reference) {
        setError('Référence de paiement absente.');
        setPhase('ready');
        return;
      }
      const r = refresh
        ? await refreshMyCardTopup(t, reference)
        : await getMyCardTopup(t, reference);
      if (r.ok && r.data) {
        setTopup(r.data);
        setError(null);
      } else {
        setError(apiError(r, 'Paiement introuvable.'));
      }
      setPhase('ready');
    },
    [reference],
  );

  useEffect(() => {
    (async () => {
      const t = await getSessionToken();
      if (!t) {
        router.replace('/auth');
        return;
      }
      const m = await fetchMe(t);
      if (!m) {
        setPhase('denied');
        return;
      }
      setToken(t);
      setMe(m);
      setPhase('ready');
      await load(t, true);
    })();
  }, [router, load]);

  // Relecture serveur périodique tant que l'état peut encore bouger.
  useEffect(() => {
    if (!token || !topup || !ACTIVE.includes(topup.status)) return;
    if (polls.current >= 40) return; // ~2 min maximum
    const id = window.setTimeout(() => {
      polls.current += 1;
      void (async () => {
        const r = await refreshMyCardTopup(token, reference);
        if (r.ok && r.data) setTopup(r.data);
      })();
    }, 3000);
    return () => window.clearTimeout(id);
  }, [token, topup, reference]);

  const refresh = async () => {
    if (!token) return;
    setBusy(true);
    const r = await refreshMyCardTopup(token, reference);
    setBusy(false);
    if (r.ok && r.data) setTopup(r.data);
    else toast.error(apiError(r, 'Relecture impossible.'));
  };

  if (phase === 'loading') {
    return (
      <AppShell me={null} nav={CLIENT_NAV} activeHref="/client/portefeuille">
        <PageLoading />
      </AppShell>
    );
  }

  if (phase === 'denied') {
    return (
      <AppShell
        me={null}
        nav={CLIENT_NAV}
        tenant={{ label: 'Espace client' }}
        activeHref="/client/portefeuille"
      >
        <div className="auth-wrap">
          <div className="auth-card">
            <h2>Connexion requise</h2>
            <p>Connectez-vous pour suivre votre paiement.</p>
            <a className="btn-primary" href="/auth">
              Se connecter
            </a>
          </div>
        </div>
      </AppShell>
    );
  }

  const status = topup?.status;
  const label = status ? (CARD_PAYMENT_LABEL[status] ?? status) : 'Inconnu';
  const tone = status ? (CARD_PAYMENT_TONE[status] ?? 'neutral') : 'neutral';

  return (
    <AppShell
      me={me}
      nav={CLIENT_NAV}
      tenant={{ label: 'Espace client' }}
      activeHref="/client/portefeuille"
    >
      <div className="wrap-md">
        <PageIntro
          eyebrow="Espace client"
          title="Paiement par carte"
          sub="État confirmé par le serveur après votre passage sur la page de paiement. Aucun numéro de carte n'est saisi ni conservé par Code Diali."
        />

        {canceled && (
          <Alert tone="warn" title="Paiement interrompu">
            Vous avez quitté la page de paiement. Votre portefeuille n'a pas été
            débité : vous pouvez reprendre quand vous voulez.
          </Alert>
        )}

        {error && <Alert tone="error" title="Impossible de charger">{error}</Alert>}

        {!topup ? (
          <EmptyState title="Aucun paiement">
            Aucun paiement ne correspond à cette référence.
          </EmptyState>
        ) : (
          <div className="grid-2 mb">
            <Panel
              title={`Référence ${topup.reference}`}
              sub={`Créé le ${new Date(topup.createdAt).toLocaleString()}`}
            >
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Statut</span>
                <Badge tone={tone}>{label}</Badge>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Montant</span>
                <b>{formatCents(topup.amountCents)} {topup.currency}</b>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Remboursé</span>
                <b>{formatCents(topup.refundedCents)} {topup.currency}</b>
              </div>
              {topup.paidAt && (
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Payé le</span>
                  <b>{new Date(topup.paidAt).toLocaleString()}</b>
                </div>
              )}
              {topup.expiresAt && status === 'CREATED' && (
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Expire le</span>
                  <b>{new Date(topup.expiresAt).toLocaleString()}</b>
                </div>
              )}
              <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                {status === 'CREATED' && 'Le paiement n’a pas encore été constaté.'}
                {status === 'PROCESSING' &&
                  'Paiement en cours côté prestataire : aucun crédit tant que la confirmation n’arrive pas.'}
                {status === 'SUCCEEDED' &&
                  'Paiement confirmé par le serveur : le montant est crédité à votre portefeuille.'}
                {status === 'FAILED' &&
                  (topup.failureMessage ?? 'Paiement refusé : aucun montant crédité.')}
                {status === 'CANCELED' && 'Paiement annulé : aucun montant crédité.'}
                {status === 'EXPIRED' && 'Session expirée : aucun montant crédité.'}
                {(status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED') &&
                  'Remboursement traité vers votre carte (voir l’historique administrateur).'}
                {status === 'NEEDS_REVIEW' &&
                  'Une incohérence a été détectée : le paiement est bloqué pour vérification (aucun crédit approximatif).'}
              </p>
            </Panel>

            <Panel title="Actions" sub="Le serveur relit systématiquement le prestataire.">
              {topup.checkoutUrl && (
                <div className="row mb">
                  <a
                    className="btn-primary"
                    href={topup.checkoutUrl}
                    rel="noreferrer"
                  >
                    {status === 'CREATED' ? 'Ouvrir la page de paiement' : 'Reprendre le paiement'}
                  </a>
                </div>
              )}
              <div className="row">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || !ACTIVE.includes(status ?? '')}
                  onClick={() => void refresh()}
                >
                  {busy ? 'Relecture…' : 'Rafraîchir maintenant'}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => router.push('/client/portefeuille')}>
                  Retour au portefeuille
                </Button>
              </div>
              {topup.interventionNeeded && (
                <Alert tone="error" title="Intervention requise">
                  {topup.interventionReason ??
                    'Un signalement a été ouvert : contactez l’assistance.'}
                </Alert>
              )}
              {topup.disputedAt && (
                <Alert tone="warn" title="Litige carte signalé">
                  Un litige a été enregistré le{' '}
                  {new Date(topup.disputedAt).toLocaleString()} : le traitement est
                  conservateur (solde inchangé jusqu’à vérification).
                </Alert>
              )}
              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Paiement en mode test — la plateforme ne peut pas être activée en
                production depuis cet écran.
              </p>
            </Panel>
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default function PaymentStatusPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PaymentStatusContent />
    </Suspense>
  );
}
