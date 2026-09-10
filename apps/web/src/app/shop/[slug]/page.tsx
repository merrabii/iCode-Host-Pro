'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { StoreShell } from '@/components/store-shell';
import { useCart } from '@/components/cart-provider';
import { useToast } from '@/components/toast';
import { IconChevronLeft, IconPlus, IconShield } from '@/components/icons';
import {
  apiError,
  billingCycleLabel,
  formatCents,
  getPublicProduct,
  type PublicProduct,
} from '@/lib/api';

/**
 * Fiche produit /shop/[slug]. La page ne touche pas au panier elle-même :
 * le panier est fourni par <CartProvider> qui n'existe qu'À L'INTÉRIEUR de
 * <StoreShell>. Le CTA (« Continuer ») + récap sont donc isolés dans
 * <PurchasePanel>, rendu comme enfant de StoreShell pour être sous le provider.
 */
export default function ShopProductPage() {
  const params = useParams(); // sync dans un composant client (Next 15)
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;

  const [product, setProduct] = useState<PublicProduct | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [selected, setSelected] = useState<Record<string, string>>({});
  const [addons, setAddons] = useState<Record<string, boolean>>({});

  useEffect(() => {
    (async () => {
      if (!slug) { setNotFound(true); return; }
      const res = await getPublicProduct(slug);
      if (!res.ok) {
        if (res.status === 404) setNotFound(true);
        else setError(apiError(res, 'Impossible de charger la fiche produit.'));
        return;
      }
      const p = res.data as PublicProduct;
      setProduct(p);
      const defs: Record<string, string> = {};
      for (const o of p.options ?? []) {
        if (o.required && o.choices.length) defs[o.id] = o.choices[0].id;
      }
      setSelected(defs);
    })();
  }, [slug]);

  const optionsHt = useMemo(() => {
    let acc = 0;
    for (const o of product?.options ?? []) {
      const c = o.choices.find((c) => c.id === selected[o.id]);
      acc += c?.priceDeltaHtCents ?? 0;
    }
    return acc;
  }, [product, selected]);

  const addonsHt = useMemo(() => {
    let acc = 0;
    for (const a of product?.addons ?? []) if (addons[a.id]) acc += a.priceHtCents;
    return acc;
  }, [product, addons]);

  if (notFound) {
    return (
      <StoreShell>
        <div className="store-single">
          <Link href="/shop" className="store-back"><IconChevronLeft size={15} /> Retour à la boutique</Link>
          <div className="store-empty">Fiche produit introuvable.</div>
        </div>
      </StoreShell>
    );
  }

  if (!product && !error) return <StoreShell><div className="store-loading">Chargement…</div></StoreShell>;

  return (
    <StoreShell>
      <div className="store-single">
        <Link href="/shop" className="store-back"><IconChevronLeft size={15} /> Retour à la boutique</Link>
        {error && <div className="alert error">{error}</div>}

        {product && (
          <div className="store-detail">
            {/* ── Colonne fiche ─────────────────────────────────────── */}
            <div className="store-detail-main">
              <div
                className="store-detail-banner"
                style={{ background: `linear-gradient(135deg, ${product.color ?? 'var(--brand-primary)'}, color-mix(in srgb, ${product.color ?? 'var(--brand-primary)'} 40%, #000))` }}
              >
                <span className="store-detail-chip">{product.category?.name ?? product.kind}</span>
              </div>

              <h1 className="store-detail-title">{product.name}</h1>
              {product.slogan && <p className="store-detail-slogan">{product.slogan}</p>}

              {product.pack && (
                <div className="store-resources">
                  {product.pack.ramMb ? <span>{product.pack.ramMb} Mo RAM</span> : null}
                  {product.pack.cpuCores ? <span>{product.pack.cpuCores} CPU</span> : null}
                  {product.pack.storageLimit ? <span>{product.pack.storageLimit} Go</span> : null}
                  {product.pack.bandwidth ? <span>{product.pack.bandwidth}</span> : null}
                </div>
              )}

              {product.shortDescription && <p className="store-detail-desc muted">{product.shortDescription}</p>}

              {product.description && (
                <div className="store-rich" dangerouslySetInnerHTML={{ __html: product.description }} />
              )}

              {/* ── Options configurables ───────────────────────────── */}
              {(product.options?.length ?? 0) > 0 && (
                <section className="store-config">
                  <h2>Configuration</h2>
                  {product.options!.map((o) => (
                    <div key={o.id} className="store-option">
                      <div className="store-option-head">
                        <b>{o.name}</b>
                        {o.required ? <span className="badge-info">Requis</span> : <span className="badge">Optionnel</span>}
                      </div>
                      <div className="store-option-choices">
                        {o.choices.map((c) => {
                          const active = selected[o.id] === c.id;
                          return (
                            <button
                              key={c.id}
                              type="button"
                              className={`store-choice${active ? ' active' : ''}`}
                              onClick={() => setSelected((s) => ({ ...s, [o.id]: c.id }))}
                            >
                              <span>{c.label}</span>
                              {c.priceDeltaHtCents !== 0 && (
                                <span className="store-choice-price">+{formatCents(c.priceDeltaHtCents)}</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </section>
              )}

              {/* ── Add-ons ─────────────────────────────────────────── */}
              {(product.addons?.length ?? 0) > 0 && (
                <section className="store-config">
                  <h2>Suppléments</h2>
                  {product.addons!.map((a) => (
                    <label key={a.id} className="store-addon">
                      <input
                        type="checkbox"
                        checked={!!addons[a.id]}
                        onChange={(e) => setAddons((s) => ({ ...s, [a.id]: e.target.checked }))}
                      />
                      <span className="store-addon-body">
                        <span className="store-addon-name"><IconPlus size={13} /> {a.name}</span>
                        {a.description && <span className="muted store-addon-desc">{a.description}</span>}
                      </span>
                      <span className="store-choice-price">
                        +{formatCents(a.priceHtCents)}
                        <span className="muted" style={{ fontSize: 11 }}>{billingCycleLabel(product.billingCycle)}</span>
                      </span>
                    </label>
                  ))}
                </section>
              )}
            </div>

            {/* ── Colonne récap / "Continuer" (sous CartProvider) ──── */}
            <PurchasePanel
              product={product}
              selected={selected}
              addons={addons}
            />
          </div>
        )}
      </div>
    </StoreShell>
  );
}

/** Récap + CTA « Continuer » → écrit le panier (navigateur) → /cart.
 *  Doit être rendu sous <CartProvider> (donc enfant de <StoreShell>). */
function PurchasePanel({
  product,
  selected,
  addons,
}: {
  product: PublicProduct;
  selected: Record<string, string>;
  addons: Record<string, boolean>;
}) {
  const router = useRouter();
  const toast = useToast();
  const { setItem } = useCart();

  const optionsHt = useMemo(() => {
    let acc = 0;
    for (const o of product.options ?? []) {
      const c = o.choices.find((c) => c.id === selected[o.id]);
      acc += c?.priceDeltaHtCents ?? 0;
    }
    return acc;
  }, [product, selected]);

  const addonsHt = useMemo(() => {
    let acc = 0;
    for (const a of product.addons ?? []) if (addons[a.id]) acc += a.priceHtCents;
    return acc;
  }, [product, addons]);

  const base = product.priceHtCents ?? 0;
  const total = base + optionsHt + addonsHt;

  /** "Continuer" → mémorise la config dans le panier (navigateur) puis /cart. */
  function continuer() {
    const optionsMap: Record<string, { id: string; label: string; priceDeltaHtCents: number }> = {};
    for (const o of product.options ?? []) {
      const c = o.choices.find((c) => c.id === selected[o.id]);
      if (c) optionsMap[o.id] = { id: c.id, label: c.label, priceDeltaHtCents: c.priceDeltaHtCents };
    }
    const addonsMap: Record<string, { id: string; name: string; priceHtCents: number }> = {};
    for (const a of product.addons ?? []) if (addons[a.id]) addonsMap[a.id] = { id: a.id, name: a.name, priceHtCents: a.priceHtCents };

    setItem({
      product: {
        id: product.id,
        name: product.name,
        slug: product.slug,
        priceHtCents: product.priceHtCents,
        promoPriceHtCents: product.promoPriceHtCents,
        billingCycle: product.billingCycle,
        color: product.color,
        allowEditConfig: product.allowEditConfig ?? true,
        installationFeeCents: product.installationFeeCents ?? 0,
        taxRatePercent:
          product.taxRate != null ? Number(product.taxRate.ratePercent) : 0,
        checkoutFields: product.checkoutFields ?? [],
      },
      options: optionsMap,
      addons: addonsMap,
    });
    toast.ok('Produit ajouté au panier.');
    router.push('/cart');
  }

  return (
    <aside className="store-summary" aria-label="Récapitulatif">
      <div className="store-summary-box">
        <h3>{product.name}</h3>
        <ul className="store-totals">
          <li><span>Souscription</span><span>{formatCents(base)}</span></li>
          {optionsHt !== 0 && <li><span>Options</span><span>+{formatCents(optionsHt)}</span></li>}
          {addonsHt !== 0 && <li><span>Suppléments</span><span>+{formatCents(addonsHt)}</span></li>}
        </ul>
        <div className="store-total">
          <span>Total</span>
          <strong>{formatCents(total)}</strong>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>{billingCycleLabel(product.billingCycle)}</p>

        <button
          type="button"
          className="btn-primary store-cta"
          onClick={continuer}
          disabled={product.status !== 'ACTIVE'}
        >
          {product.status === 'ACTIVE' ? 'Continuer' : 'Indisponible'}
        </button>

        <span className="muted store-secure-note">
          <IconShield size={13} /> Vous recevrez vos détails de compte par email.
        </span>
      </div>
    </aside>
  );
}