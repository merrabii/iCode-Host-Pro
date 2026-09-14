'use client';

import { useState } from 'react';
import type {
  DeploymentModule,
  PackAdmin,
  ProductAdmin,
  ProductCategory,
} from '@/lib/api';
import { ProductEditPanel } from '@/components/admin/product-edit-panel';
import { StoreSettingsDrawer } from '@/components/admin/product-store-settings';
import { ProductVitrineTab } from '@/components/admin/product-vitrine-tab';
import { ProductCategoriesTab } from '@/components/admin/product-categories-tab';
import { ProductOptionsTab } from '@/components/admin/product-options-tab';
import { ProductAddonsTab } from '@/components/admin/product-addons-tab';
import { ProductSubdomainTab } from '@/components/admin/product-subdomain-tab';
import { ProductProvisioningTab } from '@/components/admin/product-provisioning-tab';

type TabKey =
  | 'general'
  | 'vitrine'
  | 'boutique'
  | 'categories'
  | 'options'
  | 'addons'
  | 'subdomain'
  | 'provisioning';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'general', label: 'Général' },
  { key: 'vitrine', label: 'Vitrine' },
  { key: 'boutique', label: 'Boutique' },
  { key: 'categories', label: 'Catégories' },
  { key: 'options', label: 'Options' },
  { key: 'addons', label: 'Add-ons' },
  { key: 'subdomain', label: 'Sous-domaines' },
  { key: 'provisioning', label: 'Mise à disposition' },
];

/** Éditeur produit à onglets unifiés : fusionne l'édition existante (Général,
 *  Boutique) avec la vitrine Bloc A et les onglets Bloc B. */
export function ProductEditor({
  product,
  token,
  categories,
  packs,
  modules,
  onUpdated,
}: {
  product: ProductAdmin;
  token: string;
  categories: ProductCategory[];
  packs: PackAdmin[];
  modules: DeploymentModule[];
  onUpdated?: () => void;
}) {
  const [tab, setTab] = useState<TabKey>('general');

  return (
    <div className="editor-wrap" style={{ marginTop: 8 }}>
      <div className="tabs" role="tablist" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              border: `1px solid ${tab === t.key ? 'var(--active-border)' : 'var(--border-soft)'}`,
              background: tab === t.key ? 'var(--active-bg)' : 'var(--card-bg-2)',
              color: tab === t.key ? 'var(--active-text)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <ProductEditPanel
          key={`${product.id}-general`}
          product={product}
          token={token}
          categories={categories}
          packs={packs}
          modules={modules}
          onUpdated={onUpdated}
        />
      )}
      {tab === 'vitrine' && (
        <ProductVitrineTab key={`${product.id}-vitrine`} product={product} token={token} onUpdated={onUpdated} />
      )}
      {tab === 'boutique' && (
        <StoreSettingsDrawer key={`${product.id}-boutique`} product={product} token={token} onUpdated={onUpdated} />
      )}
      {tab === 'categories' && (
        <ProductCategoriesTab key={`${product.id}-categories`} productId={product.id} token={token} categories={categories} onUpdated={onUpdated} />
      )}
      {tab === 'options' && (
        <ProductOptionsTab key={`${product.id}-options`} productId={product.id} token={token} onUpdated={onUpdated} />
      )}
      {tab === 'addons' && (
        <ProductAddonsTab key={`${product.id}-addons`} productId={product.id} token={token} onUpdated={onUpdated} />
      )}
      {tab === 'subdomain' && (
        <ProductSubdomainTab key={`${product.id}-subdomain`} productId={product.id} token={token} onUpdated={onUpdated} />
      )}
      {tab === 'provisioning' && (
        <ProductProvisioningTab key={`${product.id}-provisioning`} productId={product.id} token={token} onUpdated={onUpdated} />
      )}
    </div>
  );
}

export default ProductEditor;