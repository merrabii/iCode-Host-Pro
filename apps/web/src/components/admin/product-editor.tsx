'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DeploymentModule,
  PackAdmin,
  ProductAdmin,
  ProductCategory,
} from '@/lib/api';
import { ProductEditPanel } from '@/components/admin/product-edit-panel';
import { StoreSettingsDrawer } from '@/components/admin/product-store-settings';
import { ProductVitrineTab } from '@/components/admin/product-vitrine-tab';
import { ProductRoadmapTab, type RoadmapTabKey } from '@/components/admin/product-roadmap-tab';
import { ProductPublicLinksTab } from '@/components/admin/product-public-links-tab';
import { ProductCategoriesTab } from '@/components/admin/product-categories-tab';
import { ProductOptionsTab } from '@/components/admin/product-options-tab';
import { ProductAddonsTab } from '@/components/admin/product-addons-tab';
import { ProductSubdomainTab } from '@/components/admin/product-subdomain-tab';
import { ProductProvisioningTab } from '@/components/admin/product-provisioning-tab';
import { ConfirmDialog } from '@/components/confirm-dialog';

type TabKey =
  | 'roadmap'
  | 'general'
  | 'vitrine'
  | 'public'
  | 'boutique'
  | 'categories'
  | 'options'
  | 'addons'
  | 'subdomain'
  | 'provisioning';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'roadmap', label: 'Roadmap' },
  { key: 'general', label: 'Général' },
  { key: 'vitrine', label: 'Vitrine' },
  { key: 'public', label: 'Liens Public' },
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
  const [tab, setTab] = useState<TabKey>('roadmap');
  const [dirtyTabs, setDirtyTabs] = useState<string[]>([]);
  const [pendingLeave, setPendingLeave] = useState<{ next: TabKey } | null>(null);
  const dirtyTabsRef = useRef<string[]>([]);
  dirtyTabsRef.current = dirtyTabs;

  // Registre des onglets à modifications non enregistrées (formulaires).
  const onDirtyChange = useCallback((key: string, dirty: boolean) => {
    setDirtyTabs((prev) => {
      const has = prev.includes(key);
      if (dirty && !has) return [...prev, key];
      if (!dirty && has) return prev.filter((k) => k !== key);
      return prev;
    });
  }, []);

  // Alerte le navigateur si on quitte la page avec des modifs non enregistrées.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirtyTabsRef.current.length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  // Bloque le changement d'onglet tant que des modifs ne sont pas enregistrées,
  // via une boîte de confirmation PLATEFORME (pas de window.confirm navigateur).
  function selectTab(next: TabKey) {
    if (next === tab) return;
    if (dirtyTabsRef.current.length > 0) {
      setPendingLeave({ next });
      return;
    }
    setTab(next);
  }

  function confirmLeave() {
    if (!pendingLeave) return;
    setTab(pendingLeave.next);
    setPendingLeave(null);
  }

  const hasDirty = dirtyTabs.length > 0;

  return (
    <div className="editor-wrap" style={{ marginTop: 8 }}>
      {hasDirty && (
        <div className="alert warn" style={{ marginBottom: 10 }}>
          <b>Modifications non enregistrées.</b> Enregistrez chaque onglet (⚠) avant de changer
          d&apos;onglet ou de quitter cette page, sinon elles seront perdues.
        </div>
      )}

      <div className="tabs" role="tablist" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => selectTab(t.key)}
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
            {dirtyTabs.includes(t.key) && <span style={{ color: 'var(--warning)' }}> ⚠</span>}
          </button>
        ))}
      </div>

      {tab === 'roadmap' && (
        <ProductRoadmapTab
          key={`${product.id}-roadmap`}
          product={product}
          onNavigate={(t: RoadmapTabKey) => selectTab(t)}
        />
      )}
      {tab === 'general' && (
        <ProductEditPanel
          key={`${product.id}-general`}
          product={product}
          token={token}
          categories={categories}
          packs={packs}
          modules={modules}
          onUpdated={onUpdated}
          onDirtyChange={onDirtyChange}
        />
      )}
      {tab === 'vitrine' && (
        <ProductVitrineTab key={`${product.id}-vitrine`} product={product} token={token} onUpdated={onUpdated} onDirtyChange={onDirtyChange} />
      )}
      {tab === 'public' && (
        <ProductPublicLinksTab key={`${product.id}-public`} product={product} />
      )}
      {tab === 'boutique' && (
        <StoreSettingsDrawer key={`${product.id}-boutique`} product={product} token={token} onUpdated={onUpdated} onDirtyChange={onDirtyChange} />
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

      {pendingLeave && (
        <ConfirmDialog
          title="Modifications non enregistrées"
          message="Des modifications ne sont pas encore enregistrées. Changer d&apos;onglet les perdra. Quitter quand même ?"
          confirmLabel="Quitter quand même"
          cancelLabel="Rester et enregistrer"
          tone="warn"
          onConfirm={confirmLeave}
          onCancel={() => setPendingLeave(null)}
        />
      )}
    </div>
  );
}

export default ProductEditor;