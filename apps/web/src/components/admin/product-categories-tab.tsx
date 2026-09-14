'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  listProductCategories,
  setProductCategories,
  unlinkProductCategory,
  type CategoryLinkView,
  type ProductCategory,
} from '@/lib/api';
import { useToast } from '@/components/toast';
import { Badge, Button, EmptyState, Panel } from '@/components/ui';
import { IconX } from '@/components/icons';

/** Onglet « Catégories » — catégories liées d'un produit (en plus de la principale). */
export function ProductCategoriesTab({
  productId,
  token,
  categories,
  onUpdated,
}: {
  productId: string;
  token: string;
  categories: ProductCategory[];
  onUpdated?: () => void;
}) {
  const toast = useToast();
  const [linked, setLinked] = useState<CategoryLinkView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const r = await listProductCategories(token, productId);
    if (r.ok) setLinked((r.data as CategoryLinkView[]) ?? []);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  // La catégorie principale se gère dans l'onglet Général ; ici on associe/retire les catégories liées.
  const linkedIds = new Set(linked.map((l) => l.category.id));

  function toggle(cid: string) {
    setLinked((prev) => {
      const present = prev.some((l) => l.category.id === cid);
      if (present) return prev.filter((l) => l.category.id !== cid);
      return [...prev, { id: `__new__${cid}`, category: categories.find((c) => c.id === cid)! }];
    });
  }

  async function save() {
    setBusy('save');
    const r = await setProductCategories(token, productId, linked.map((l) => l.category.id));
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de l’enregistrement des catégories.'));
    toast.ok('Catégories liées enregistrées.');
    onUpdated?.();
    await load();
  }

  async function unlink(linkId: string, cid: string) {
    setBusy(linkId);
    const r = await unlinkProductCategory(token, productId, cid);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec du retrait de la catégorie.'));
    toast.ok('Catégorie retirée.');
    await load();
  }

  const unsavedOnly = linked.some((l) => l.id.startsWith('__new__'));

  return (
    <Panel
      title="Catégories liées"
      sub="Les catégories associées en plus de la principale (affichées en vitrine)."
      className="mb"
    >
      <div className="stack" style={{ gap: 10 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Cliquez pour ajouter/retirer. Le bouton « Enregistrer » applique l'ensemble en une seule opération.
        </div>
        {categories.length === 0 ? (
          <EmptyState>
            <div className="muted">Aucune catégorie disponible. Créez-en une sur la page Catégories.</div>
          </EmptyState>
        ) : (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {categories.map((c) => {
              const active = linkedIds.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggle(c.id)}
                  className="chip-toggle"
                  aria-pressed={active}
                  style={{
                    border: `1px solid ${active ? 'var(--active-border)' : 'var(--border-soft)'}`,
                    background: active ? 'var(--active-bg)' : 'var(--card-bg-2)',
                    color: active ? 'var(--active-text)' : 'var(--text-secondary)',
                    padding: '6px 10px',
                    borderRadius: 999,
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                >
                  {c.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {linked.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 18 }}>
            <h3>Liées actuellement</h3>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {linked.map((l) => (
              <div
                key={l.id}
                className="row"
                style={{
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 12px',
                  border: '1px solid var(--border-soft)',
                  borderRadius: 8,
                  background: 'var(--card-bg-2)',
                }}
              >
                <Badge tone="blue">{l.category.name}</Badge>
                {!l.id.startsWith('__new__') ? (
                  <Button size="sm" variant="secondary" disabled={busy === l.id} onClick={() => unlink(l.id, l.category.id)}>
                    <IconX size={13} /> Retirer
                  </Button>
                ) : (
                  <span className="muted" style={{ fontSize: 12 }}>nouveau</span>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="grid-form-actions" style={{ marginTop: 14 }}>
        <Button onClick={save} disabled={busy === 'save' || categories.length === 0}>
          {busy === 'save' ? 'Enregistrement…' : unsavedOnly ? 'Enregistrer les catégories' : 'Enregistrer'}
        </Button>
      </div>
    </Panel>
  );
}

export default ProductCategoriesTab;