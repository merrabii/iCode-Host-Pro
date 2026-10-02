'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { StoreShell } from '@/components/store-shell';
import { IconAlert, IconCheck, IconChevronRight, IconInfo, IconRefresh } from '@/components/icons';
import { getOrderStatus } from '@/lib/api';

const ORDER_KEY = 'codiali.order.v1';

/** États OrderStatus renvoyés par GET /store/orders/:id/status (sans PII). */
type OrderStatusInfo = { found: boolean; status?: string };

/** Libellés fidèles aux statuts réels — AUCUNE affirmation d'activation,
 *  d'application disponible ou de libération de ressources. Le jargon
 *  interne (« confirmé par le serveur »…) reste hors des textes client. */
const STATUS_COPY: Record<string, { title: string; sub: string; tone: 'ok' | 'wait' | 'bad' }> = {
  PENDING_PAYMENT: {
    title: 'Commande reçue',
    sub: 'Le paiement de cette commande n’est pas encore confirmé.',
    tone: 'wait',
  },
  PAID: {
    title: 'Commande payée',
    sub: 'Le paiement de cette commande est confirmé.',
    tone: 'ok',
  },
  PROVISIONING: {
    title: 'Commande confirmée',
    sub: 'La mise en place de votre commande est en cours.',
    tone: 'ok',
  },
  ACTIVE: {
    title: 'Commande active',
    sub: 'Cette commande est active.',
    tone: 'ok',
  },
  CANCELLED: {
    title: 'Commande annulée',
    sub: 'Cette commande a été annulée.',
    tone: 'bad',
  },
};

/** « Prochaine étape » (promesse d'email / identifiants) : affichée UNIQUEMENT
 *  pour les statuts où le flux l'effectue réellement. Jamais pour
 *  CANCELLED (aucune promesse de déploiement / identifiants / activation). */
const NEXT_STEP_COPY: Partial<Record<string, string>> = {
  PAID: 'Vous recevrez un email avec vos identifiants et l’accès à votre application. Retrouvez l’état de votre commande dans votre espace client.',
  PROVISIONING: 'Vous recevrez un email avec vos identifiants et l’accès à votre application. Retrouvez l’état de votre commande dans votre espace client.',
  ACTIVE: 'Vous recevrez un email avec vos identifiants et l’accès à votre application. Retrouvez l’état de votre commande dans votre espace client.',
};

/** Page de confirmation — doit TOUJOURS exister (fini la 404). useSearchParams
 *  est à l'intérieur d'un <Suspense> pour rester compatible avec le rendu
 *  statique de `next build`. L'état affiché provient de
 *  GET /store/orders/:id/status (source réelle), complété par le récap
 *  sessionStorage s'il est encore présent dans l'onglet. */
export default function CheckoutSuccessPage() {
  return (
    <Suspense fallback={<StoreShell><div className="store-loading" role="status">Chargement…</div></StoreShell>}>
      <SuccessInner />
    </Suspense>
  );
}

function SuccessInner() {
  const sp = useSearchParams();
  const orderId = sp.get('orderId') ?? '';
  const [saved, setSaved] = useState<{ orderId?: string; invoiceNumber?: string; email?: string; subdomain?: string } | null>(null);
  const [savedLoaded, setSavedLoaded] = useState(false);

  // Vérification de l'état réel (retry piloté par `attempt`).
  const [check, setCheck] = useState<OrderStatusInfo | null>(null); // null = en cours ou échec
  const [checkError, setCheckError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Garde anti-réponse périmée : seule la réponse de la DERNIÈRE référence
  // demandée (changement d'orderId en cours de vol) a le droit d'écrire l'état.
  const seqRef = useRef(0);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(ORDER_KEY);
      if (raw) setSaved(JSON.parse(raw));
    } catch { /* noop */ }
    setSavedLoaded(true);
  }, []);

  const verify = useCallback(async () => {
    const seq = ++seqRef.current;
    setCheckError(false);
    setCheck(null);
    const res = await getOrderStatus(orderId);
    if (seq !== seqRef.current) return; // réponse périmée (référence changée)
    if (!res) { setCheckError(true); return; }
    setCheck(res);
  }, [orderId]);

  useEffect(() => {
    if (!orderId) return;
    verify();
  }, [orderId, attempt, verify]);

  // ── États d'attente / erreur de vérification ────────────────────
  if (!orderId) {
    return (
      <StoreShell>
        <div className="store-single">
          <div className="store-success">
            <div className="store-success-badge warn"><IconInfo size={30} /></div>
            <h1 className="store-detail-title">Référence de commande manquante</h1>
            <p className="store-success-sub muted">
              Ce lien ne contient pas de référence de commande. Si vous venez de valider un paiement,
              retrouvez votre commande dans votre espace client.
            </p>
            <div className="store-success-actions">
              <Link href="/shop" className="btn-primary">Retour à la boutique</Link>
            </div>
          </div>
        </div>
      </StoreShell>
    );
  }

  if (checkError) {
    return (
      <StoreShell>
        <div className="store-single">
          <div className="store-success">
            <div className="store-success-badge warn"><IconRefresh size={30} /></div>
            <h1 className="store-detail-title">Vérification impossible</h1>
            <p className="store-success-sub muted" role="alert">
              Nous ne parvenons pas à vérifier l’état de votre commande pour le moment.
              Aucun état n’est affirmé tant que la vérification n’a pas abouti.
            </p>
            <div className="store-success-actions">
              <button type="button" className="btn-primary" onClick={() => setAttempt((a) => a + 1)}>
                Réessayer
              </button>
              <Link href="/shop" className="btn-secondary">Retour à la boutique</Link>
            </div>
          </div>
        </div>
      </StoreShell>
    );
  }

  if (!check) {
    return (
      <StoreShell>
        <div className="store-loading" role="status">Vérification de votre commande…</div>
      </StoreShell>
    );
  }

  if (!check.found) {
    return (
      <StoreShell>
        <div className="store-single">
          <div className="store-success">
            <div className="store-success-badge warn"><IconInfo size={30} /></div>
            <h1 className="store-detail-title">Commande introuvable</h1>
            <p className="store-success-sub muted" role="alert">
              Aucune commande ne correspond à cette référence. Vérifiez le lien de confirmation
              reçu ou la référence indiquée dans votre espace client.
            </p>
            <div className="store-success-card">
              <div className="store-success-row">
                <span>Référence</span>
                <strong>{orderId}</strong>
              </div>
            </div>
            <div className="store-success-actions">
              <Link href="/shop" className="btn-primary">Retour à la boutique</Link>
              <Link href="/auth" className="btn-secondary">Se connecter</Link>
            </div>
          </div>
        </div>
      </StoreShell>
    );
  }

  // ── Commande trouvée : état réel ───────────────────────────────
  const st = check.status ?? '';
  const copy = STATUS_COPY[st] ?? {
    title: 'Commande enregistrée',
    sub: `État actuel : ${st || 'inconnu'}.`,
    tone: 'wait' as const,
  };
  const BadgeIcon = copy.tone === 'ok' ? IconCheck : copy.tone === 'bad' ? IconAlert : IconInfo;
  // Récap sessionStorage : affiché UNIQUEMENT si sa référence correspond à
  // celle de l'URL (sinon : récap d'une autre commande → aucune donnée).
  const savedMatch = !!saved && saved.orderId === orderId;
  const nextStep = NEXT_STEP_COPY[st];

  return (
    <StoreShell>
      <div className="store-single">
        <div className="store-success">
          <div className={`store-success-badge ${copy.tone}`}>
            <BadgeIcon size={30} />
          </div>
          <h1 className="store-detail-title">{copy.title}</h1>
          <p className="store-success-sub muted">{copy.sub}</p>

          <div className="store-success-card">
            <div className="store-success-row">
              <span>Commande</span>
              <strong>{orderId}</strong>
            </div>
            <div className="store-success-row">
              <span>État</span>
              <strong>{st || '—'}</strong>
            </div>
            {savedMatch && saved?.invoiceNumber && (
              <div className="store-success-row">
                <span>Facture</span>
                <strong>{saved.invoiceNumber}</strong>
              </div>
            )}
            {savedMatch && saved?.email && (
              <div className="store-success-row">
                <span>Email de commande</span>
                <strong>{saved.email}</strong>
              </div>
            )}
            {savedMatch && saved?.subdomain && (
              <div className="store-success-row">
                <span>Sous-domaine choisi</span>
                <strong>{saved.subdomain}</strong>
              </div>
            )}
          </div>

          {savedLoaded && !savedMatch && (
            <p className="muted" style={{ fontSize: 12.5, textAlign: 'center' }}>
              {nextStep
                ? 'Le récapitulatif détaillé n’est plus disponible dans cet onglet : retrouvez facture et identifiants dans votre espace client.'
                : 'Le récapitulatif détaillé n’est pas disponible dans cet onglet : retrouvez les informations de votre commande dans votre espace client.'}
            </p>
          )}

          {nextStep && (
            <div className="store-success-note">
              <p><b>Quelle est la prochaine étape ?</b></p>
              <p>{nextStep}</p>
            </div>
          )}

          <div className="store-success-actions">
            <Link href="/client" className="btn-primary">Accéder à mon espace <IconChevronRight size={15} /></Link>
            <Link href="/shop" className="btn-secondary">Retour à la boutique</Link>
          </div>
        </div>
      </div>
    </StoreShell>
  );
}
