'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  createProductAddon,
  deleteProductAddon,
  listProductAddons,
  reorderProductAddons,
  updateProductAddon,
  type ProductAddonRow,
} from '@/lib/api';
import { useToast } from '@/components/toast';
import { Badge, Button, EmptyState, Field, Input, Panel } from '@/components/ui';
import { IconChevronDown, IconChevronUp, IconPlus, IconTrash, IconX } from '@/components/icons';

function dollars(v?: number | null): string {
  return v == null || Number.isNaN(v) ? '' : (v / 100).toFixed(2);
}

/** Onglet « Add-ons » — suppléments proposés à la commande du produit. */
export function ProductAddonsTab({
  productId,
  token,
  onUpdated,
}: {
  productId: string;
  token: string;
  onUpdated?: () => void;
}) {
  const toast = useToast();
  const [addons, setAddons] = useState<ProductAddonRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const r = await listProductAddons(token, productId);
    if (r.ok) setAddons((r.data as ProductAddonRow[]) ?? []);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  // Formulaire d'ajout
  const [adding, setAdding] = useState(false);
  const [an, setAn] = useState('');
  const [ad, setAd] = useState('');
  const [ap, setAp] = useState('');
  async function addAddon() {
    if (!an.trim()) return toast.error('Le nom de l’add-on est obligatoire.');
    const cents = Math.round(parseFloat(ap.replace(',', '.')) * 100);
    if (!Number.isFinite(cents)) return toast.error('Prix invalide.');
    setBusy('add');
    const r = await createProductAddon(token, productId, {
      name: an.trim(),
      description: ad.trim() || undefined,
      priceHtCents: cents,
      sortOrder: addons.length,
    });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la création de l’add-on.'));
    toast.ok('Add-on créé.');
    setAn('');
    setAd('');
    setAp('');
    setAdding(false);
    await load();
  }

  // Édition
  const [editId, setEditId] = useState<string | null>(null);
  const [en, setEn] = useState('');
  const [ed, setEd] = useState('');
  const [ep, setEp] = useState('');
  function startEdit(a: ProductAddonRow) {
    setEditId(a.id);
    setEn(a.name);
    setEd(a.description ?? '');
    setEp(dollars(a.priceHtCents));
  }
  async function saveEdit() {
    if (!en.trim()) return toast.error('Le nom est obligatoire.');
    const cents = Math.round(parseFloat(ep.replace(',', '.')) * 100);
    if (!Number.isFinite(cents)) return toast.error('Prix invalide.');
    setBusy(`edit-${editId}`);
    const r = await updateProductAddon(token, editId!, {
      name: en.trim(),
      description: ed.trim() || null,
      priceHtCents: cents,
    });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la mise à jour.'));
    toast.ok('Add-on mis à jour.');
    setEditId(null);
    await load();
  }

  // Réordonner / supprimer
  async function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= addons.length) return;
    const next = addons.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setAddons(next);
    const r = await reorderProductAddons(token, productId, next.map((a) => a.id));
    if (!r.ok) return toast.error(apiError(r, 'Réordonnancement refusé.'));
  }
  async function removeAddon(a: ProductAddonRow) {
    if (!window.confirm(`Supprimer l’add-on « ${a.name} » ?`)) return;
    setBusy(`del-${a.id}`);
    const r = await deleteProductAddon(token, a.id);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la suppression.'));
    toast.ok('Add-on supprimé.');
    await load();
  }

  return (
    <Panel
      title="Add-ons"
      sub="Suppléments facultatifs proposés à la commande (ex. maintenance, backup)."
      className="mb"
    >
      {!adding && (
        <Button size="sm" onClick={() => setAdding(true)} disabled={busy === 'add'}>
          <IconPlus size={13} /> Ajouter un add-on
        </Button>
      )}
      {adding && (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          <div className="grid-form" style={{ gap: 10 }}>
            <Field label="Nom">
              <Input value={an} onChange={(e) => setAn(e.target.value)} placeholder="Maintenance" autoFocus />
            </Field>
            <Field label="Prix HT ($)">
              <Input value={ap} onChange={(e) => setAp(e.target.value)} placeholder="5.00" inputMode="decimal" />
            </Field>
            <Field label="Description">
              <Input value={ad} onChange={(e) => setAd(e.target.value)} placeholder="Surveillance et mises à jour" />
            </Field>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" disabled={busy === 'add'} onClick={addAddon}>Créer</Button>
            <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>
              <IconX size={12} /> Annuler
            </Button>
          </div>
        </div>
      )}

      {addons.length === 0 ? (
        <EmptyState>
          <div className="muted">Aucun add-on pour ce produit.</div>
        </EmptyState>
      ) : (
        <div className="stack" style={{ gap: 8, marginTop: 12 }}>
          {addons.map((a, i) => (
            <div
              key={a.id}
              className="row"
              style={{
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                border: '1px solid var(--border-soft)',
                borderRadius: 8,
                background: 'var(--card-bg-2)',
              }}
            >
              {editId === a.id ? (
                <div className="row" style={{ gap: 8, flex: 1, flexWrap: 'wrap' }}>
                  <Input className="input-sm" value={en} onChange={(e) => setEn(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
                  <Input
                    className="input-sm"
                    value={ep}
                    onChange={(e) => setEp(e.target.value)}
                    style={{ width: 100 }}
                    inputMode="decimal"
                  />
                  <Input className="input-sm" value={ed} onChange={(e) => setEd(e.target.value)} placeholder="Description" style={{ flex: 1, minWidth: 140 }} />
                  <Button size="sm" disabled={busy === `edit-${a.id}`} onClick={saveEdit}>OK</Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditId(null)}>Annuler</Button>
                </div>
              ) : (
                <>
                  <Badge tone="blue">{a.name}</Badge>
                  <span className="muted" style={{ fontSize: 12 }}>{dollars(a.priceHtCents)} $/cycle</span>
                  {a.description && (
                    <span className="muted" style={{ fontSize: 12, flex: 1 }}>{a.description}</span>
                  )}
                </>
              )}
              <div className="row" style={{ marginLeft: 'auto', gap: 4 }}>
                <Button size="sm" variant="secondary" disabled={i === 0} title="Monter" onClick={() => move(i, -1)}>
                  <IconChevronUp size={13} />
                </Button>
                <Button size="sm" variant="secondary" disabled={i === addons.length - 1} title="Descendre" onClick={() => move(i, 1)}>
                  <IconChevronDown size={13} />
                </Button>
                <Button size="sm" variant="secondary" title="Modifier" onClick={() => startEdit(a)}>✎</Button>
                <Button size="sm" variant="danger" disabled={busy === `del-${a.id}`} title="Supprimer" onClick={() => removeAddon(a)}>
                  <IconTrash size={13} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export default ProductAddonsTab;