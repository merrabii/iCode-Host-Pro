'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { StoreShell } from '@/components/store-shell';
import { useCart } from '@/components/cart-provider';
import { useToast } from '@/components/toast';
import { IconChevronLeft, IconMail, IconShield } from '@/components/icons';
import { billingCycleLabel, formatCents, storeCheckout } from '@/lib/api';
import { buyerStorage } from '@/lib/cart';

/** Vue publique d'un moyen de paiement actif (id, name, type, config non secrète). */
interface PaymentMethodView {
  id: string;
  name: string;
  type: string;
  config?: unknown;
}

/** Résultat de POST /store/checkout conservé pour la page de succès. */
interface CheckoutResult {
  orderId: string;
  invoiceNumber?: string;
  email?: string;
  subdomain?: string;
}

const ORDER_KEY = 'codiali.order.v1';

export default function CheckoutPaymentPage() {
  return (
    <StoreShell>
      <CheckoutPaymentView />
    </StoreShell>
  );
}

function CheckoutPaymentView() {
  const router = useRouter();
  const toast = useToast();
  const { item } = useCart();

  const [methods, setMethods] = useState<PaymentMethodView[] | null>(null);
  const [methodId, setMethodId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const contact = useMemo(() => buyerStorage.read(), []);

  // Chargement des moyens de paiement actifs (publics, sans secrets).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/store/payment-methods');
        if (!res.ok) { setMethods([]); return; }
        const data = (await res.json()) as PaymentMethodView[];
        setMethods(data);
        if (data.length) setMethodId((id) => id || data[0].id);
      } catch { setMethods([]); }
    })();
  }, []);

  // Sans produit dans le panier → retour boutique.
  useEffect(() => {
    if (item === null) return; // le panier s'hydrate après le montage (localStorage)
  }, [item]);

  const subdomain = item?.subdomain;
  const productSlug = item?.product.slug ?? null;

  async function confirmer(e: FormEvent) {
    e.preventDefault();
    if (!item || !productSlug) { toast.error('Panier incomplet — repassez par la boutique.'); return; }
    if (!contact) { toast.error('Coordonnées manquantes — revenez à l’étape précédente.'); return; }
    if (!methodId) { toast.error('Choisissez un moyen de paiement.'); return; }

    setLoading(true);
    setError(null);
    try {
      const res = await storeCheckout({
        productSlug,
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        paymentMethodId: methodId,
        subdomain,
        useAccountDetails: contact.useAccountDetails,
      });
      const data = res.data as unknown;
      if (!res.ok) {
        const msg = (data as { message?: string } | null)?.message;
        setError(msg && typeof msg === 'string' ? msg : 'Échec de la commande. Réessayez.');
        return;
      }
      const r = data as CheckoutResult;
      if (!r.subdomain && subdomain) r.subdomain = subdomain; // retour API sans sous-domaine ? on garde le choix
      // Persister l'ordre pour la page de succès (id + numéro de facture).
      try { sessionStorage.setItem(ORDER_KEY, JSON.stringify(r)); } catch { /* noop */ }
      router.replace(`/checkout/success?orderId=${encodeURIComponent(r.orderId)}`);
    } finally {
      setLoading(false);
    }
  }

  if (item === null) {
    return (
      <div className="store-single">
        <Link href="/shop" className="store-back"><IconChevronLeft size={15} /> Retour à la boutique</Link>
        <div className="store-empty">
          <h3 style={{ color: 'var(--text-primary)', marginBottom: 8 }}>Aucun produit à payer</h3>
          <p>Votre panier est vide. Parcourez la boutique pour commencer.</p>
          <Link href="/shop" className="btn-primary" style={{ width: 'fit-content', marginTop: 16 }}>Découvrir la boutique</Link>
        </div>
      </div>
    );
  }

  const subtotal = item.product.priceHtCents ?? 0;
  const optionsHt = Object.values(item.options ?? {}).reduce((a, o) => a + o.priceDeltaHtCents, 0);
  const addonsHt = Object.values(item.addons ?? {}).reduce((a, x) => a + x.priceHtCents, 0);
  const installation = item.product.installationFeeCents ?? 0;
  const taxRate = item.product.taxRatePercent ?? 0;
  const tax = Math.round(((subtotal + optionsHt + addonsHt) * taxRate) / 100);
  const total = subtotal + optionsHt + addonsHt + installation + tax;

  return (
    <div className="store-single">
      <Link href="/cart" className="store-back"><IconChevronLeft size={15} /> Retour au récapitulatif</Link>
      <header>
        <h1 className="store-detail-title">Paiement</h1>
        <p className="muted">Confirmez le moyen de paiement — la commande est validée immédiatement et votre abonnement devient actif.</p>
      </header>

      {error && <div className="alert error">{error}</div>}

      <div className="store-cart">
        {/* Colonne récap */}
        <section className="store-cart-recap">
          <div className="store-summary-box">
            <h3>{item.product.name}</h3>
            <p className="muted" style={{ fontSize: 12.5 }}>{billingCycleLabel(item.product.billingCycle)}</p>

            {subdomain && (
              <div className="store-cart-subdomain">
                <span className="store-recap-label">Adresse de votre application</span>
                <span className="store-cart-subdomain-val">https://{subdomain}.…</span>
              </div>
            )}

            <ul className="store-totals">
              <li><span>Souscription</span><span>{formatCents(subtotal)}</span></li>
              {optionsHt !== 0 && <li><span>Options</span><span>+{formatCents(optionsHt)}</span></li>}
              {addonsHt !== 0 && <li><span>Suppléments</span><span>+{formatCents(addonsHt)}</span></li>}
              <li><span>Installation</span><span>{formatCents(installation)}</span></li>
              {tax !== 0 && <li><span>Taxe ({taxRate} %)</span><span>{formatCents(tax)}</span></li>}
            </ul>
            <div className="store-total">
              <span>Total</span>
              <strong>{formatCents(total)}</strong>
            </div>

            <div className="store-contact-note">
              <IconMail size={16} />
              <div>
                <b>Détails de compte à {contact?.email ?? '…'}</b>
                <span>Votre compte client, vos identifiants et l'accès à votre application vous seront envoyés à cette adresse.</span>
              </div>
            </div>
          </div>
        </section>

        {/* Colonne moyen de paiement */}
        <form className="store-cart-form" onSubmit={confirmer} noValidate>
          <div className="store-config">
            <h2>Moyen de paiement</h2>

            {methods === null && <p className="muted">Chargement des moyens de paiement…</p>}
            {methods !== null && methods.length === 0 && (
              <div className="alert error">Aucun moyen de paiement n'est actif pour le moment.</div>
            )}

            {methods !== null && methods.length > 0 && (
              <div className="store-payment-methods">
                {methods.map((m) => (
                  <label key={m.id} className={`store-payment${methodId === m.id ? ' active' : ''}`}>
                    <input
                      type="radio"
                      name="method"
                      value={m.id}
                      checked={methodId === m.id}
                      onChange={() => setMethodId(m.id)}
                    />
                    <span className="store-payment-body">
                      <span className="store-payment-name">{m.name}</span>
                      {m.type === 'CARD' && <span className="muted" style={{ fontSize: 12 }}>Carte bancaire</span>}
                      {configText(m.config) && <span className="muted store-payment-config">{configText(m.config)}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}

            <div className="store-contact-note">
              <IconShield size={16} />
              <div>
                <b>Paiement simulé</b>
                <span>À cette étape de validation, la commande est enregistrée et votre abonnement activé immédiatement. Aucune carte n'est débitée.</span>
              </div>
            </div>
          </div>

          <button type="submit" className="btn-primary store-cta" disabled={loading || methods === null || methods.length === 0}>
            {loading ? 'Commande en cours…' : 'Confirmer la commande'}
          </button>
        </form>
      </div>
    </div>
  );
}

/** Extrait un court texte d'instruction d'un `config` (objet Json non secret). */
function configText(config?: unknown): ReactNode | string | null {
  if (config == null) return null;
  if (typeof config === 'string') return config;
  if (typeof config === 'object') {
    const c = config as Record<string, unknown>;
    const v =
      c.instructions ?? c.details ?? c.iban ?? c.ibanLabel ?? c.bankName ?? c.coords ?? c.text;
    if (typeof v === 'string') return v;
  }
  return null;
}