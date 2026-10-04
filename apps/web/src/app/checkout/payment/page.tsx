'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { StoreShell } from '@/components/store-shell';
import { useCart } from '@/components/cart-provider';
import { IconChevronLeft, IconMail, IconShield } from '@/components/icons';
import {
  billingCycleLabel,
  formatCents,
  listPaymentMethods,
  storeCheckout,
  type PublicPaymentMethod,
} from '@/lib/api';
import { buyerStorage } from '@/lib/cart';

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
  const { item, ready } = useCart();

  const [methods, setMethods] = useState<PublicPaymentMethod[] | null>(null);
  const [methodsError, setMethodsError] = useState(false);
  const [methodId, setMethodId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Q-A (GO item 4) — consentement EXPLICITE au renouvellement automatique :
  // NON coché par défaut (aucun prélèvement sans action volontaire).
  const [renewalConsent, setRenewalConsent] = useState(false);

  const contact = useMemo(() => buyerStorage.read(), []);

  // Chargement des moyens de paiement ACTIFS (publics, sans secrets) — via le
  // helper API (plus de fetch en dur) + état d'erreur distingué de la liste vide.
  const loadMethods = useMemo(() => {
    let seq = 0;
    return async () => {
      const my = ++seq;
      setMethodsError(false);
      const res = await listPaymentMethods();
      if (my !== seq) return; // réponse périmée (double appel)
      if (!res.ok) {
        setMethods(null);
        setMethodsError(true);
        return;
      }
      const data = (Array.isArray(res.data) ? res.data : []) as PublicPaymentMethod[];
      setMethods(data);
      if (data.length) setMethodId((id) => id || data[0].id);
    };
  }, []);

  useEffect(() => {
    loadMethods();
  }, [loadMethods]);

  // Hydratation du panier confirmée ET aucun produit → retour boutique promis
  // (avant : effet vide qui ne redirigeait jamais).
  useEffect(() => {
    if (ready && !item) router.replace('/shop');
  }, [ready, item, router]);

  const subdomain = item?.subdomain;
  const requestedDomainId = item?.requestedDomainId;
  const productSlug = item?.product.slug ?? null;

  async function confirmer(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!item || !productSlug) { setError('Panier incomplet — repassez par la boutique.'); return; }
    if (!contact) { setError('Coordonnées manquantes — revenez à l’étape précédente.'); return; }
    if (!methodId) { setError('Choisissez un moyen de paiement.'); return; }

    setLoading(true);
    try {
      const res = await storeCheckout({
        productSlug,
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        paymentMethodId: methodId,
        subdomain,
        requestedDomainId,
        useAccountDetails: contact.useAccountDetails,
        renewalConsent,
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
      // La page de succès re-vérifiera l'état réel côté serveur.
      try { sessionStorage.setItem(ORDER_KEY, JSON.stringify(r)); } catch { /* noop */ }
      router.replace(`/checkout/success?orderId=${encodeURIComponent(r.orderId)}`);
    } finally {
      setLoading(false);
    }
  }

  if (!ready) {
    return <div className="store-loading" role="status">Chargement du panier…</div>;
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
        <p className="muted">Vérifiez le récapitulatif, puis confirmez votre commande.</p>
      </header>

      {error && (
        <div className="alert error" role="alert">
          {isUpgradeRefusal(error) ? (
            <>
              <b>Le changement d&apos;offre n&apos;est pas encore disponible en ligne.</b>{' '}
              Contactez l&apos;assistance pour connaître les possibilités.{' '}
              <Link className="alert-retry" href="/client?rub=help">
                Contacter l&apos;assistance
              </Link>
            </>
          ) : (
            error
          )}
        </div>
      )}

      <div className="store-cart">
        {/* Colonne moyens de paiement (gauche) — en premier dans le DOM :
            ordre clavier = ordre visuel (actions → récap). */}
        <form className="store-cart-form" onSubmit={confirmer} noValidate>
          <div className="store-config">
            <h2>Moyen de paiement</h2>

            {/* États : chargement / erreur réseau / aucun moyen actif (blocage
                expliqué) / liste réelle des moyens actifs renvoyés par l'API. */}
            {methods === null && !methodsError && (
              <p className="muted" role="status">Chargement des moyens de paiement…</p>
            )}
            {methodsError && (
              <div className="alert error" role="alert">
                Impossible de charger les moyens de paiement.{' '}
                <button type="button" className="alert-retry" onClick={() => loadMethods()}>
                  Réessayer
                </button>
              </div>
            )}
            {methods !== null && methods.length === 0 && !methodsError && (
              <div className="alert error" role="alert">
                <b>Paiement indisponible :</b> aucun moyen de paiement n&apos;est actuellement actif.
                La confirmation de commande est donc bloquée — réessayez plus tard.
              </div>
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
                <b>Aucune saisie de carte</b>
                <span>Ce tunnel n&apos;exige aucune carte bancaire : le paiement est géré par le moyen de paiement ci-dessus. L&apos;état de votre commande s&apos;affiche ensuite sur la page de confirmation.</span>
              </div>
            </div>

            {/* Q-A (GO item 4) — renouvellement automatique : consentement
                EXPLICITE (case NON cochée par défaut), révocable à tout moment
                depuis « Mes commandes ». */}
            {item.product.billingCycle !== 'ONETIME' && (
              <label
                className="store-contact-note"
                style={{ cursor: 'pointer', alignItems: 'flex-start' }}
              >
                <input
                  type="checkbox"
                  checked={renewalConsent}
                  onChange={(e) => setRenewalConsent(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <div>
                  <b>Renouvellement automatique</b>
                  <span>
                    À chaque échéance ({billingCycleLabel(item.product.billingCycle)}), le montant
                    de la période suivante est prélevé sur mon solde portefeuille. Sans cette case,
                    aucun prélèvement automatique n&apos;est planifié. Révocable à tout moment
                    depuis « Mes commandes ».
                  </span>
                </div>
              </label>
            )}
          </div>

          <button type="submit" className="btn-primary store-cta" disabled={loading || methods === null || methods.length === 0}>
            {loading ? 'Commande en cours…' : 'Confirmer la commande'}
          </button>
        </form>

        {/* Colonne récap (droite) — après le formulaire dans le DOM et à
            droite sur desktop (montants et règles de calcul inchangés). */}
        <section className="store-cart-recap">
          <div className="store-summary-box">
            <h3>{item.product.name}</h3>
            <p className="muted" style={{ fontSize: 12.5 }}>{billingCycleLabel(item.product.billingCycle)}</p>

            {subdomain && (
              <div className="store-cart-subdomain">
                <span className="store-recap-label">Sous-domaine choisi</span>
                <span className="store-cart-subdomain-val">{subdomain}</span>
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
      </div>
    </div>
  );
}

/**
 * Refus backend d'une commande « changement de pack » pour un compte déjà
 * abonné (limite serveur, message brut technique) → reformulé côté client en
 * langage clair + action assistance (aucun jargon interne affiché).
 */
function isUpgradeRefusal(msg: string): boolean {
  return /upgrade non pris en charge|abonnement actif existant/i.test(msg);
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