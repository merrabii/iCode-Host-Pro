'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { StoreShell } from '@/components/store-shell';
import { useCart } from '@/components/cart-provider';
import { useToast } from '@/components/toast';
import { IconChevronLeft, IconChevronRight, IconMail, IconShield } from '@/components/icons';
import { billingCycleLabel, formatCents } from '@/lib/api';
import { buyerStorage } from '@/lib/cart';

type FieldDef = {
  id: string;
  key: string;
  label: string;
  type: string;
  placeholder?: string | null;
  required: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+0-9 ()-]{6,20}$/;

/** Page /cart. <CartView> est enfant de <StoreShell> → sous <CartProvider>. */
export default function CartPage() {
  return (
    <StoreShell>
      <CartView />
    </StoreShell>
  );
}

function CartView() {
  const router = useRouter();
  const toast = useToast();
  const { item, clear } = useCart();

  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Champs affichés : ceux du produit (enabled) sinon les 3 par défaut.
  const fields = useMemo<FieldDef[]>(() => {
    const cf = item?.product.checkoutFields ?? [];
    if (cf.length > 0) return cf;
    return [
      { id: 'name', key: 'name', label: 'Nom complet', type: 'TEXT', required: true },
      { id: 'email', key: 'email', label: 'Adresse email', type: 'EMAIL', required: true },
      { id: 'phone', key: 'phone', label: 'Téléphone', type: 'TEL', required: true },
    ];
  }, [item]);

  const email = (values.email ?? '').trim();

  // Pré-remplir depuis le buyerStorage (retour /cart) et initialiser les valeurs.
  useEffect(() => {
    const c = buyerStorage.read();
    const init: Record<string, string> = {};
    for (const f of fields) {
      if (c && c[f.key as 'name']) init[f.key] = c[f.key as 'name'] as string;
    }
    setValues(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.map((f) => f.key).join(','), item?.product.id]);

  const optionsList = useMemo(() => Object.values(item?.options ?? {}), [item]);
  const addonsList = useMemo(() => Object.values(item?.addons ?? {}), [item]);

  const subtotal = useMemo(() => {
    if (!item) return 0;
    let acc = item.product.priceHtCents ?? 0;
    for (const o of Object.values(item.options ?? {})) acc += o.priceDeltaHtCents;
    for (const a of Object.values(item.addons ?? {})) acc += a.priceHtCents;
    return acc;
  }, [item]);

  const installation = item?.product.installationFeeCents ?? 0;
  const taxRate = item?.product.taxRatePercent ?? 0; // %
  const tax = Math.round((subtotal * taxRate) / 100);
  const total = subtotal + installation + tax;

  const allowEdit = item?.product.allowEditConfig ?? true;

  function validate(): boolean {
    const next: Record<string, string> = {};
    for (const f of fields) {
      const v = (values[f.key] ?? '').trim();
      if (f.required && !v) {
        next[f.key] = 'Ce champ est requis.';
        continue;
      }
      if (!v) continue; // optionnel vide OK
      if (f.type === 'EMAIL' && !EMAIL_RE.test(v)) next[f.key] = 'Adresse email invalide.';
      if (f.type === 'TEL' && !PHONE_RE.test(v)) next[f.key] = 'Numéro de téléphone invalide.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function commander(e: FormEvent) {
    e.preventDefault();
    if (!item) return;
    if (!validate()) return;
    const contact = { name: (values.name ?? '').trim(), email, phone: (values.phone ?? '').trim() };
    buyerStorage.write(contact);
    toast.ok('Coordonnées enregistrées.');
    router.push('/checkout/payment');
  }

  // ── Panier vide ────────────────────────────────────────────────
  if (!item) {
    return (
      <div className="store-single">
        <Link href="/shop" className="store-back">
          <IconChevronLeft size={15} /> Retour à la boutique
        </Link>
        <div className="store-empty">
          <h3 style={{ color: 'var(--text-primary)', marginBottom: 8 }}>Votre panier est vide</h3>
          <p>Parcourez la boutique et choisissez une offre pour continuer.</p>
          <Link href="/shop" className="btn-primary" style={{ width: 'fit-content', marginTop: 16 }}>
            Découvrir la boutique
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="store-single">
      <header>
        <h1 className="store-detail-title">Finaliser votre commande</h1>
        <p className="muted">Dernière étape avant le paiement — vos données restent dans ce navigateur tant que le paiement n'est pas validé.</p>
      </header>

      <div className="store-cart">
        {/* Colonne récap (à droite) */}
        <section className="store-cart-recap">
          <div className="store-summary-box">
            <h3>{item.product.name}</h3>
            <p className="muted" style={{ fontSize: 12.5 }}>{billingCycleLabel(item.product.billingCycle)}</p>

            <ul className="store-totals">
              <li><span>Souscription</span><span>{formatCents(item.product.priceHtCents)}</span></li>
            </ul>

            {optionsList.length > 0 && (
              <>
                <div className="store-recap-label">Options</div>
                <ul className="store-recap">
                  {optionsList.map((o) => (
                    <li key={o.id}>
                      <span>{o.label}</span>
                      {o.priceDeltaHtCents !== 0 && <span>+{formatCents(o.priceDeltaHtCents)}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {addonsList.length > 0 && (
              <>
                <div className="store-recap-label">Suppléments</div>
                <ul className="store-recap">
                  {addonsList.map((a) => (
                    <li key={a.id}>
                      <span>{a.name}</span>
                      <span>+{formatCents(a.priceHtCents)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <ul className="store-totals" style={{ marginTop: 6 }}>
              <li>
                <span>Prix d'installation</span>
                <span>{formatCents(installation)}</span>
              </li>
              <li>
                <span>Taxe {taxRate > 0 ? `(${taxRate} %)` : ''}</span>
                <span>{formatCents(tax)}</span>
              </li>
            </ul>

            <div className="store-total">
              <span>Total</span>
              <strong>{formatCents(total)}</strong>
            </div>

            {allowEdit && (
              <button type="button" className="btn-secondary store-recap-edit" onClick={() => {
                clear();
                router.push(`/shop/${item.product.slug ?? ''}`);
              }}>
                Modifier la configuration
              </button>
            )}
          </div>
        </section>

        {/* Colonne coordonnées */}
        <form className="store-cart-form" onSubmit={commander} noValidate>
          <div className="store-config">
            <h2>Vos coordonnées</h2>

            {fields.map((f) => (
              <div className="field" key={f.id}>
                <label htmlFor={`cf-${f.id}`}>
                  {f.label} {f.required && <span className="req">*</span>}
                </label>
                <input
                  id={`cf-${f.id}`}
                  className="input"
                  type={f.type === 'EMAIL' ? 'email' : f.type === 'TEL' ? 'tel' : 'text'}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={f.placeholder ?? undefined}
                  autoComplete={f.type === 'EMAIL' ? 'email' : f.type === 'TEL' ? 'tel' : 'name'}
                />
                {errors[f.key] && <span className="store-field-error">{errors[f.key]}</span>}
              </div>
            ))}

            {/* Encart DesignSystem : détails de compte sur cet email */}
            <div className="store-contact-note">
              <IconMail size={16} />
              <div>
                <b>Vos détails de compte vous seront envoyés à cette adresse.</b>
                {email && !errors.email ? (
                  <span>Après paiement validé, votre compte client et vos identifiants seront livrés à <strong className="store-contact-email">{email}</strong>.</span>
                ) : (
                  <span>Renseignez votre email ci-dessus : c'est là que vous recevrez vos détails de compte et votre sous-domaine gratuit.</span>
                )}
              </div>
            </div>
          </div>

          <button type="submit" className="btn-primary store-cta">
            Commander <IconChevronRight size={15} />
          </button>

          <span className="muted store-secure-note" style={{ justifyContent: 'center' }}>
            <IconShield size={13} /> Aucun compte n'est créé tant que le paiement n'est pas validé.
          </span>
        </form>
      </div>
    </div>
  );
}