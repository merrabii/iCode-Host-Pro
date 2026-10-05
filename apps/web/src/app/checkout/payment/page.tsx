'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { StoreShell } from '@/components/store-shell';
import { useCart } from '@/components/cart-provider';
import { IconChevronLeft, IconMail, IconShield } from '@/components/icons';
import {
  billingCycleLabel,
  formatCents,
  listPaymentMethods,
  promoActive,
  quoteCart,
  storeCheckout,
  type PublicPaymentMethod,
  type QuoteResult,
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
  // Q7 (GO item 7) — total SERVEUR : devis `/store/quote` re-fetché à chaque
  // changement (panier ou moyen sélectionné) avec les FRAIS du moyen — le
  // total affiché EST le total confirmé/débité. Jamais de calcul local.
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteKey, setQuoteKey] = useState('');
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState(false);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const quoteSeqRef = useRef(0);
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

  // Q7 — devis serveur : configuration EXACTE à confirmer + moyen sélectionné
  // (frais inclus). Clé du devis = clé de la confirmation : le bouton reste
  // bloqué tant que le total affiché n'est pas celui du moyen courant.
  const quoteKeyNow = useMemo(() => {
    const slug = item?.product.slug;
    if (!slug) return '';
    const options = Object.entries(item.options ?? {}).map(([optionId, c]) => ({
      optionId,
      choiceId: c.id,
    }));
    const addonIds = Object.keys(item.addons ?? {});
    return JSON.stringify([slug, methodId, options, addonIds]);
  }, [item, methodId]);

  useEffect(() => {
    if (!ready || !quoteKeyNow || !methodId) {
      setQuote(null);
      setQuoteKey('');
      return;
    }
    let cancelled = false;
    const [slug, mid, options, addonIds] = JSON.parse(quoteKeyNow) as [
      string,
      string,
      { optionId: string; choiceId: string }[],
      string[],
    ];
    const my = ++quoteSeqRef.current;
    setQuoteLoading(true);
    setQuoteError(false);
    void (async () => {
      const res = await quoteCart({ productSlug: slug, options, addonIds, paymentMethodId: mid });
      if (cancelled || my !== quoteSeqRef.current) return;
      setQuoteLoading(false);
      if (!res.ok || !res.data) {
        setQuote(null);
        setQuoteKey('');
        setQuoteError(true);
        return;
      }
      setQuote(res.data);
      setQuoteKey(quoteKeyNow);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, quoteKeyNow, methodId, quoteNonce]);

  const subdomain = item?.subdomain;
  const requestedDomainId = item?.requestedDomainId;
  const productSlug = item?.product.slug ?? null;

  async function confirmer(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!item || !productSlug) { setError('Panier incomplet — repassez par la boutique.'); return; }
    if (!contact) { setError('Coordonnées manquantes — revenez à l’étape précédente.'); return; }
    if (!methodId) { setError('Choisissez un moyen de paiement.'); return; }
    // Q7 — jamais de confirmation sur un total non servé/re-accepté.
    if (quoteError || quoteLoading || !quote || quoteKey !== quoteKeyNow) {
      setError('Le total n’est pas encore confirmé par le serveur — patientez puis réessayez.');
      return;
    }

    const options = Object.entries(item.options ?? {}).map(([optionId, c]) => ({
      optionId,
      choiceId: c.id,
    }));
    const addonIds = Object.keys(item.addons ?? {});

    setLoading(true);
    try {
      const res = await storeCheckout({
        productSlug,
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        paymentMethodId: methodId,
        options,
        addonIds,
        subdomain,
        requestedDomainId,
        useAccountDetails: contact.useAccountDetails,
        renewalConsent,
        // Total serveur affiché ci-contre : toute divergence tarifaire survenant
        // entre l'affichage et la confirmation → 409 PRICING_CHANGED (ré-acceptation).
        acceptedTotalTtcCents: quote.amountTtcCents,
        // P7 — preuve COMPLÈTE du devis serveur (devise + moyen + empreinte) :
        // le serveur recompare total, devise, moyen et empreinte tarifaire.
        acceptedCurrency: quote.currency,
        acceptedPaymentMethodId: quote.paymentMethodId ?? methodId,
        acceptedQuoteKey: quote.quoteKey,
      });
      const data = res.data as unknown;
      if (!res.ok) {
        if (res.status === 409 && (data as { code?: string } | null)?.code === 'PRICING_CHANGED') {
          const current = (data as { currentTotalTtcCents?: number } | null)?.currentTotalTtcCents;
          setError(
            typeof current === 'number'
              ? `Le tarif a changé : nouveau total ${formatCents(current)}. Vérifiez le récapitulatif, puis confirmez à nouveau.`
              : 'Les conditions tarifaires ont changé. Vérifiez le nouveau total, puis confirmez à nouveau.',
          );
          // Re-fetch immédiat du devis courant : le récap affiche le NOUVEAU total.
          setQuoteNonce((n) => n + 1);
          return;
        }
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

  // Q7 (GO item 7) — TOTAUX SERVEUR uniquement : lignes du devis `/store/quote`
  // correspondant à la config + au moyen courants (frais inclus). Aucun calcul
  // local de prix/taxe : ce qui s'affiche ici EST le total débité.
  const quoteFresh = !!quote && quoteKey === quoteKeyNow;
  const lines = quoteFresh ? quote.lines : [];
  const total = quoteFresh ? quote.amountTtcCents : null;
  const taxRate = quoteFresh ? Number(quote.taxRatePercent) : 0;
  const quoteTax = quoteFresh ? quote.taxAmountCents : 0;

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
                      {feeLabel(m) && <span className="muted" style={{ fontSize: 12 }}>{feeLabel(m)}</span>}
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

          <button
            type="submit"
            className="btn-primary store-cta"
            disabled={
              loading ||
              methods === null ||
              methods.length === 0 ||
              quoteLoading ||
              quoteError ||
              !quoteFresh
            }
          >
            {loading ? 'Commande en cours…' : !quoteFresh && !quoteError ? 'Total en cours de calcul…' : 'Confirmer la commande'}
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
              {quoteFresh ? (
                <>
                  {lines.map((l, i) => (
                    <li key={i}>
                      <span>{l.kind === 'PRODUCT' ? 'Souscription' : l.label}</span>
                      <span>{formatCents(l.unitPriceHtCents)}</span>
                    </li>
                  ))}
                  <li>
                    <span>Taxe ({taxRate} %)</span>
                    <span>{formatCents(quoteTax)}</span>
                  </li>
                </>
              ) : (
                <li>
                  <span>Total</span>
                  <span aria-hidden="true">…</span>
                </li>
              )}
            </ul>
            <div className="store-total">
              <span>Total</span>
              <strong>{total !== null ? formatCents(total) : quoteError ? '—' : '…'}</strong>
            </div>
            {quoteFresh && promoActive(quote.product) && (
              <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
                Prix catalogue <s>{formatCents(quote.product.priceHtCents)}</s> — promo appliquée
                au tarif affiché.
              </p>
            )}
            {quoteLoading && !quoteFresh && (
              <p className="muted" style={{ fontSize: 12 }} role="status">
                Calcul du total par le serveur…
              </p>
            )}
            {quoteError && (
              <div className="alert error" role="alert" style={{ marginTop: 8 }}>
                Impossible de calculer le total serveur.{' '}
                <button type="button" className="alert-retry" onClick={() => setQuoteNonce((n) => n + 1)}>
                  Réessayer
                </button>
              </div>
            )}

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

/** Q7 (GO item 7) — libellé des frais d'un moyen (grille publique APPLIQUÉE
 *  dans le devis/commande, affichée ici pour que le client la voie AVANT de
 *  sélectionner le moyen). `NONE` ou frais nuls → rien. */
function feeLabel(m: PublicPaymentMethod): string | null {
  const t = m.feeType;
  if (!t || t === 'NONE') return null;
  const parts: string[] = [];
  if ((t === 'PERCENT' || t === 'PERCENT_AND_FIXED') && m.feePercent) {
    parts.push(`${m.feePercent} %`);
  }
  if ((t === 'FIXED' || t === 'PERCENT_AND_FIXED') && m.feeFixedCents) {
    parts.push(formatCents(m.feeFixedCents));
  }
  if (!parts.length) return null;
  return `Frais de paiement en sus : ${parts.join(' + ')}`;
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