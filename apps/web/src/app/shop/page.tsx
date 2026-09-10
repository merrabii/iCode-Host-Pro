'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { StoreShell } from '@/components/store-shell';
import { useBrand } from '@/components/brand-provider';
import { IconCheck, IconChevronRight, IconSearch } from '@/components/icons';
import {
  apiError,
  billingCycleLabel,
  formatCents,
  listPublicProducts,
  type PublicProduct,
} from '@/lib/api';

/** Prix de la carte : promo barrée si présente, sinon prix HT, sinon "Sur devis". */
function PriceTag({ p }: { p: PublicProduct }) {
  const hasPromo =
    p.promoPriceHtCents != null && p.priceHtCents != null && p.promoPriceHtCents < p.priceHtCents;
  if (!p.priceHtCents && !p.promoPriceHtCents) return <span className="muted" style={{ fontSize: 13 }}>Sur devis</span>;
  return (
    <div className="store-price">
      <span className="store-price-num">{formatCents(p.priceHtCents)}</span>
      <span className="store-price-meta">
        {billingCycleLabel(p.billingCycle)}
        {hasPromo && p.promoPriceHtCents != null && (
          <><s className="store-price-old">{formatCents(p.promoPriceHtCents)}</s></>
        )}
      </span>
    </div>
  );
}

export default function ShopPage() {
  const { brand } = useBrand();
  const [products, setProducts] = useState<PublicProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    (async () => {
      const res = await listPublicProducts();
      if (!res.ok) {
        setError(apiError(res, 'Impossible de charger la boutique.'));
        return;
      }
      setProducts((res.data as PublicProduct[]) ?? []);
    })();
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products ?? []) {
      const label = p.category?.name ?? p.kind ?? 'Autre';
      set.add(label);
    }
    return ['all', ...set].map((name) => ({
      name,
      label: name === 'all' ? 'Tout' : name,
    }));
  }, [products]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (products ?? []).filter((p) => {
      const cat = p.category?.name ?? p.kind ?? 'Autre';
      if (filter !== 'all' && cat !== filter) return false;
      if (!needle) return true;
      const hay = `${p.name} ${p.slogan ?? ''} ${p.shortDescription ?? ''} ${cat}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [products, q, filter]);

  return (
    <StoreShell>
      <section className="store-hero">
        <span className="store-hero-chip"><span className="dot" /> Boutique officielle</span>
        <h1>
          Hébergez votre app, <span className="store-hero-grad">en quelques clics.</span>
        </h1>
        <p>
          Chaque offre de {brand.name} est configurable. Choisissez vos options, finalisez vos
          coordonnées et recevez votre sous-domaine gratuit par email.
        </p>
        <div className="store-hero-perks">
          {['Provisionnement immédiat', 'Sous-domaine gratuit', 'Support prioritaire'].map((t) => (
            <span key={t}><IconCheck size={13} /> {t}</span>
          ))}
        </div>
      </section>

      {/* Barre de recherche + filtres */}
      <div className="store-toolbar">
        <label className="store-search">
          <IconSearch size={16} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher une offre, un service…"
            aria-label="Rechercher"
          />
        </label>
        <div className="store-filters" role="tablist">
          {categories.map((c) => (
            <button
              key={c.name}
              type="button"
              className={`store-filter${filter === c.name ? ' active' : ''}`}
              onClick={() => setFilter(c.name)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {!products && !error && (
        <div className="store-loading">Chargement de la boutique…</div>
      )}
      {error && <div className="alert error">{error}</div>}
      {products && products.length === 0 && (
        <p className="store-empty">Aucune offre disponible pour le moment.</p>
      )}
      {products && visible.length === 0 && (
        <p className="store-empty">Aucun résultat pour cette recherche.</p>
      )}

      <div className="store-grid">
        {visible.map((p) => {
          const isActive = p.status === 'ACTIVE';
          const href = isActive && p.slug ? `/shop/${p.slug}` : '#';
          return (
            <Link key={p.id} href={href} className={`store-card${isActive ? '' : ' disabled'}`}>
              <div className="store-card-head">
                <span
                  className="store-card-swatch"
                  style={{ background: p.color ?? 'var(--brand-primary)' }}
                  aria-hidden
                />
                <span className="store-card-cat">{p.category?.name ?? p.kind}</span>
                {!isActive && <span className="badge warn">{p.status}</span>}
              </div>
              <h3>{p.name}</h3>
              <p className="store-card-desc">{p.slogan || p.shortDescription || 'Service disponible dans la boutique.'}</p>

              {p.pack && (
                <div className="store-resources">
                  {p.pack.ramMb ? <span>{p.pack.ramMb} Mo RAM</span> : null}
                  {p.pack.cpuCores ? <span>{p.pack.cpuCores} CPU</span> : null}
                  {p.pack.storageLimit ? <span>{p.pack.storageLimit} Go</span> : null}
                  {p.pack.bandwidth ? <span>{p.pack.bandwidth}</span> : null}
                </div>
              )}

              {(p.options?.length ?? 0) > 0 && (
                <ul className="store-card-options">
                  {p.options!.map((o) => (
                    <li key={o.id}>
                      {o.name}
                      {o.required ? <em>req.</em> : null}
                    </li>
                  ))}
                </ul>
              )}

              <div className="store-card-foot">
                <PriceTag p={p} />
                <span className="store-card-view">
                  {isActive ? <>Choisir <IconChevronRight size={14} /></> : 'Indisponible'}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </StoreShell>
  );
}