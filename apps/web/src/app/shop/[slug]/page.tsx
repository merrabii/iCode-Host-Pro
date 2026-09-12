'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { StoreShell } from '@/components/store-shell';
import { useCart } from '@/components/cart-provider';
import { useToast } from '@/components/toast';
import {
  IconChartBar,
  IconCheck,
  IconChevronLeft,
  IconDatabase,
  IconGlobe,
  IconMail,
  IconPlus,
  IconRefresh,
  IconServer,
  IconShield,
} from '@/components/icons';
import {
  apiError,
  billingCycleLabel,
  checkStoreSubdomain,
  fetchMe,
  formatCents,
  getPublicProduct,
  getSessionToken,
  type Me,
  type PublicProduct,
} from '@/lib/api';

/** Pattern d'un sous-domaine libre (comme le DTO API). */
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Fiche produit /shop/[slug] — vitrine moderne et professionnelle. La page ne
 * touche pas au panier elle-même : le CTA + récap vivent dans <PurchasePanel>
 * (enfant de <StoreShell>, donc sous <CartProvider>). Le choix du sous-domaine
 * (produits à FreeSubdomainRule) est porté ici, dans la colonne principale,
 * juste après le titre — pas dans la colonne prix.
 */
export default function ShopProductPage() {
  const params = useParams(); // sync dans un composant client (Next 15)
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;

  const [product, setProduct] = useState<PublicProduct | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [selected, setSelected] = useState<Record<string, string>>({});
  const [addons, setAddons] = useState<Record<string, boolean>>({});

  // Sous-domaine (produits porteurs d'une FreeSubdomainRule) — état porté ici
  // pour que le choix vive dans la colonne principale ET verrouille le CTA.
  const [subdomain, setSubdomain] = useState('');
  const [fqdn, setFqdn] = useState<string | null>(null);
  const [subStatus, setSubStatus] = useState<'idle' | 'checking' | 'ok' | 'taken' | 'invalid'>('idle');
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Vérification de dispo du sous-domaine (debounce) tant que le produit en exige un.
  const needsSubdomain = !!product?.freeSubdomainRule;
  useEffect(() => {
    if (!needsSubdomain) { setSubStatus('idle'); setFqdn(null); return; }
    if (checkTimer.current) clearTimeout(checkTimer.current);
    const raw = subdomain.trim().toLowerCase();
    if (!raw) {
      setSubStatus('idle');
      setFqdn(null);
      return;
    }
    if (!SUBDOMAIN_PATTERN.test(raw)) {
      setSubStatus('invalid');
      setFqdn(null);
      return;
    }
    setSubStatus('checking');
    checkTimer.current = setTimeout(async () => {
      if (!product?.slug) { setSubStatus('invalid'); return; }
      const res = await checkStoreSubdomain(product.slug, raw);
      if (res) {
        setFqdn(res.fqdn);
        setSubStatus(res.available && res.reason !== 'taken' ? 'ok' : 'taken');
      } else {
        setSubStatus('invalid');
      }
    }, 500);
    return () => { if (checkTimer.current) clearTimeout(checkTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subdomain, needsSubdomain]);

  useEffect(() => () => { if (checkTimer.current) clearTimeout(checkTimer.current); }, []);

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
                className="store-detail-banner store-detail-banner-pro"
                style={{ background: `linear-gradient(135deg, ${product.color ?? 'var(--brand-primary)'}, color-mix(in srgb, ${product.color ?? 'var(--brand-primary)'} 40%, #000))` }}
              >
                {product.category?.name && <span className="store-detail-chip">{product.category.name}</span>}
              </div>

              <h1 className="store-detail-title">{product.name}</h1>
              {product.slogan && <p className="store-detail-slogan">{product.slogan}</p>}

              {/* ── Sous-domaine au choix (Plan Gratuit…) — juste après le
                  titre/slogan, PAS dans la colonne prix. */}
              {needsSubdomain && (
                <SubdomainChooser
                  subdomain={subdomain}
                  setSubdomain={setSubdomain}
                  fqdn={fqdn}
                  status={subStatus}
                  maxLength={product.freeSubdomainRule?.maxLength ?? 40}
                />
              )}

              {/* ── Ce qui est inclus (grille de caractéristiques) ── */}
              <section className="store-features">
                {product.pack && (
                  <>
                    {product.pack.ramMb ? <Feature icon={IconServer} label="RAM" value={`${product.pack.ramMb} Mo`} /> : null}
                    {product.pack.cpuCores ? <Feature icon={IconChartBar} label="CPU" value={`${product.pack.cpuCores}`} /> : null}
                    {product.pack.storageLimit ? <Feature icon={IconDatabase} label="Stockage" value={`${product.pack.storageLimit} Go`} /> : null}
                    {product.pack.bandwidth ? <Feature icon={IconGlobe} label="Bande passante" value={product.pack.bandwidth} /> : null}
                  </>
                )}
                <Feature icon={IconGlobe} label="Sous-domaine" value="gratuit inclus" />
                <Feature icon={IconShield} label="SSL" value="automatique" />
                <Feature icon={IconMail} label="Support" value="par email" />
              </section>

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

              {/* ── Comment ça marche ───────────────────────────────── */}
              <section className="store-how">
                <h2>Comment ça marche</h2>
                <div className="store-how-grid">
                  <HowStep n="1" title="Commandez" text="Choisissez votre sous-domaine et validez la commande." />
                  <HowStep n="2" title="Nous déployons" text="Votre application est mise en ligne et sécurisée (SSL)." />
                  <HowStep n="3" title="En ligne" text="Recevez l'adresse par email et accédez à votre espace client." />
                </div>
              </section>

              {/* ── Bande de confiance ──────────────────────────────── */}
              <div className="store-trust">
                <span><IconShield size={14} /> SSL gratuit</span>
                <span><IconRefresh size={14} /> Activation rapide</span>
                <span>{product.freeSubdomainRule ? <span><IconGlobe size={14} /> Sous-domaine offert</span> : <span><IconMail size={14} /> Support par email</span>}</span>
              </div>
            </div>

            {/* ── Colonne récap / "Continuer" (sous CartProvider) ──── */}
            <PurchasePanel
              product={product}
              selected={selected}
              addons={addons}
              subdomainOk={needsSubdomain ? subStatus === 'ok' : true}
              subdomain={subdomain}
            />
          </div>
        )}
      </div>
    </StoreShell>
  );
}

/** Sélecteur de sous-domaine (colonne principale) — nom + aperçu + dispo en direct. */
function SubdomainChooser({
  subdomain,
  setSubdomain,
  fqdn,
  status,
  maxLength,
}: {
  subdomain: string;
  setSubdomain: (v: string) => void;
  fqdn: string | null;
  status: 'idle' | 'checking' | 'ok' | 'taken' | 'invalid';
  maxLength: number;
}) {
  return (
    <div className="store-subdomain card">
      <div className="store-subdomain-head">
        <div>
          <div className="store-subdomain-label">Choisissez l’adresse de votre application</div>
          <div className="muted store-subdomain-sub">Un sous-domaine gratuit et unique, activé immédiatement.</div>
        </div>
      </div>
      <div className={`store-subdomain-input${status === 'invalid' ? ' invalid' : ''}${status === 'ok' ? ' ok' : ''}`}>
        <span className="store-subdomain-prefix">https://</span>
        <input
          value={subdomain}
          onChange={(e) => setSubdomain(e.target.value)}
          placeholder="mon-app"
          autoComplete="off"
          spellCheck={false}
          maxLength={maxLength}
        />
      </div>
      <p className="store-subdomain-hint muted">
        {status === 'idle' && fqdn && <>Votre application sera servie sur <b>{fqdn}</b>.</>}
        {status === 'idle' && !fqdn && <>Lettres et chiffres, tirets autorisés.</>}
        {status === 'checking' && <>Vérification de disponibilité…</>}
        {status === 'invalid' && <span className="danger-text">Nom invalide (a–z, 0–9, tirets, sans tiret aux extrémités).</span>}
        {status === 'taken' && fqdn && <span className="danger-text">Déjà pris : {fqdn}. Essayez un autre nom.</span>}
        {status === 'ok' && fqdn && <span className="success-text">Disponible — votre app sera sur <b>{fqdn}</b>.</span>}
      </p>
    </div>
  );
}

function Feature({ icon: Icon, label, value }: { icon: (p: { size?: number }) => ReactNode; label: string; value: string }) {
  return (
    <div className="store-feature">
      <span className="store-feature-ico">{Icon ? <Icon size={16} /> : null}</span>
      <div>
        <div className="store-feature-label">{label}</div>
        <div className="store-feature-value">{value}</div>
      </div>
    </div>
  );
}

function HowStep({ n, title, text }: { n: string; title: string; text: string }) {
  return (
    <div className="store-how-step">
      <span className="store-how-n">{n}</span>
      <b>{title}</b>
      <span className="muted">{text}</span>
    </div>
  );
}

/** Récap + CTA « Continuer » → écrit le panier (navigateur) → /cart. */
function PurchasePanel({
  product,
  selected,
  addons,
  subdomainOk,
  subdomain,
}: {
  product: PublicProduct;
  selected: Record<string, string>;
  addons: Record<string, boolean>;
  subdomainOk: boolean;
  subdomain: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const { setItem } = useCart();

  // Phase 16 — Plan Gratuit auth-aware : le CTA devient « Commencez gratuitement »
  // (visiteur, pas de checkout) ou « Créer un nouveau Projet » (déjà connecté).
  const [user, setUser] = useState<Me | null>(null);
  const [authReady, setAuthReady] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const token = await getSessionToken();
      if (!token) {
        if (alive) setAuthReady(true);
        return;
      }
      const me = await fetchMe(token);
      if (alive) {
        setUser(me);
        setAuthReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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

  /** "Continuer" → mémorise la config (dont le sous-domaine) dans le panier puis /cart. */
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
      subdomain: product.freeSubdomainRule ? subdomain.trim().toLowerCase() : undefined,
    });
    toast.ok('Produit ajouté au panier.');
    router.push('/cart');
  }

  const canContinue = product.status === 'ACTIVE' && subdomainOk;

  // Plan Gratuit : pas de panier ni de checkout — bouton unique selon la session.
  const isFree = product.freePlan === true;

  function freeCta() {
    if (!isFree) return continuer();
    if (authReady && user) {
      // Déjà client → créer une app (l'espace client le prouve).
      router.push('/client/project');
    } else {
      // Visiteur → inscription autonome du Plan Gratuit (sans checkout).
      router.push(`/auth?plan=${encodeURIComponent(product.slug ?? '')}`);
    }
  }

  const ctaLabel = isFree
    ? authReady && user
      ? 'Créer un nouveau Projet'
      : 'Commencez gratuitement'
    : product.status !== 'ACTIVE'
      ? 'Indisponible'
      : !subdomainOk
        ? 'Choisissez un sous-domaine'
        : 'Continuer';

  return (
    <aside className="store-summary" aria-label="Récapitulatif">
      <div className="store-summary-box">
        <h3>{product.name}</h3>
        <p className="muted" style={{ fontSize: 12.5 }}>{billingCycleLabel(product.billingCycle)}</p>
        <ul className="store-totals">
          <li><span>Souscription</span><span>{formatCents(base)}</span></li>
          {isFree && <li><span>À la souscription</span><span>{formatCents(0)}</span></li>}
          {optionsHt !== 0 && <li><span>Options</span><span>+{formatCents(optionsHt)}</span></li>}
          {addonsHt !== 0 && <li><span>Suppléments</span><span>+{formatCents(addonsHt)}</span></li>}
        </ul>
        <div className="store-total">
          <span>Total</span>
          <strong>{formatCents(total)}</strong>
        </div>

        <button
          type="button"
          className="btn-primary store-cta"
          onClick={freeCta}
          disabled={!isFree && !canContinue}
        >
          {ctaLabel}
        </button>

        <span className="muted store-secure-note">
          {isFree ? (
            <><IconCheck size={13} /> Aucune carte requise — débloquez votre espace client immédiatement.</>
          ) : (
            <><IconCheck size={13} /> Vous recevrez vos détails d'accès par email.</>
          )}
        </span>
      </div>
    </aside>
  );
}