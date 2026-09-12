'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { StoreShell } from '@/components/store-shell';
import { IconCheck, IconChevronRight } from '@/components/icons';

const ORDER_KEY = 'codiali.order.v1';

/** Page de confirmation — doit TOUJOURS exister (fini la 404). Rendu léger :
 *  lit orderId (searchParams) + le résultat commande stocké à l'étape /payment,
 *  n'effectue aucun appel bloquant. useSearchParams est à l'intérieur d'un
 *  <Suspense> pour rester compatible avec le rendu statique de `next build`. */
export default function CheckoutSuccessPage() {
  return (
    <Suspense fallback={<StoreShell><div className="store-loading">Chargement…</div></StoreShell>}>
      <SuccessInner />
    </Suspense>
  );
}

function SuccessInner() {
  const sp = useSearchParams();
  const orderId = sp.get('orderId') ?? '';
  const [saved, setSaved] = useState<{ invoiceNumber?: string; email?: string; subdomain?: string } | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(ORDER_KEY);
      if (raw) setSaved(JSON.parse(raw));
    } catch { /* noop */ }
  }, []);

  return (
    <StoreShell>
      <div className="store-single">
        <div className="store-success">
          <div className="store-success-badge">
            <IconCheck size={30} />
          </div>
          <h1 className="store-detail-title">Commande confirmée</h1>
          <p className="store-success-sub muted">
            Merci ! Votre abonnement est actif et votre application est en cours de mise en place.
          </p>

          <div className="store-success-card">
            <div className="store-success-row">
              <span>Commande</span>
              <strong>{orderId || saved?.invoiceNumber || '—'}</strong>
            </div>
            {saved?.invoiceNumber && (
              <div className="store-success-row">
                <span>Facture</span>
                <strong>{saved.invoiceNumber}</strong>
              </div>
            )}
            {saved?.email && (
              <div className="store-success-row">
                <span>Détails de compte envoyés à</span>
                <strong>{saved.email}</strong>
              </div>
            )}
            {saved?.subdomain && (
              <div className="store-success-row">
                <span>Adresse de votre application</span>
                <strong>https://{saved.subdomain}.…</strong>
              </div>
            )}
          </div>

          <div className="store-success-note">
            <p><b>Quelle est la prochaine étape ?</b></p>
            <p>
              Vous recevrez un email avec vos identifiants et l'accès à votre application une fois celle-ci
              déployée. Retrouvez tout dans votre espace client.
            </p>
          </div>

          <div className="store-success-actions">
            <Link href="/client" className="btn-primary">Accéder à mon espace <IconChevronRight size={15} /></Link>
            <Link href="/shop" className="btn-secondary">Retour à la boutique</Link>
          </div>
        </div>
      </div>
    </StoreShell>
  );
}