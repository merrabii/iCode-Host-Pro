'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  createOptionChoice,
  createProductOption,
  deleteOptionChoice,
  deleteProductOption,
  listProductOptions,
  reorderOptionChoices,
  reorderProductOptions,
  updateOptionChoice,
  updateProductOption,
  type ProductOptionRow,
} from '@/lib/api';
import { useToast } from '@/components/toast';
import { Badge, Button, EmptyState, Field, Input, Panel } from '@/components/ui';
import { IconChevronDown, IconChevronUp, IconPlus, IconTrash, IconX } from '@/components/icons';

/** Centimes → saisie en dollars. */
function dollars(v?: number): string {
  return v == null || Number.isNaN(v) ? '' : (v / 100).toFixed(2);
}

/** Onglet « Options » — options configurables d'un produit, avec leurs choix. */
export function ProductOptionsTab({
  productId,
  token,
  onUpdated,
}: {
  productId: string;
  token: string;
  onUpdated?: () => void;
}) {
  const toast = useToast();
  const [options, setOptions] = useState<ProductOptionRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const r = await listProductOptions(token, productId);
    if (r.ok) setOptions((r.data as ProductOptionRow[]) ?? []);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  // ── Ajout d'option ──
  const [adding, setAdding] = useState(false);
  const [oname, setOname] = useState('');
  const [orequired, setOrequired] = useState(false);
  async function addOption() {
    if (!oname.trim()) return toast.error('Le nom de l’option est obligatoire.');
    setBusy('add-option');
    const r = await createProductOption(token, productId, {
      name: oname.trim(),
      required: orequired,
      sortOrder: options.length,
    });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la création de l’option.'));
    toast.ok('Option créée.');
    setOname('');
    setOrequired(false);
    setAdding(false);
    await load();
  }

  // ── Édition d'option (nom / requis) ──
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editReq, setEditReq] = useState(false);
  async function startEdit(o: ProductOptionRow) {
    setEditId(o.id);
    setEditName(o.name);
    setEditReq(o.required);
  }
  async function saveEdit() {
    if (!editName.trim()) return toast.error('Le nom est obligatoire.');
    setBusy(`edit-${editId}`);
    const r = await updateProductOption(token, editId!, { name: editName.trim(), required: editReq });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la mise à jour.'));
    toast.ok('Option mise à jour.');
    setEditId(null);
    await load();
  }

  // ── Réordonner / supprimer option ──
  async function moveOption(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= options.length) return;
    const next = options.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setOptions(next);
    const r = await reorderProductOptions(token, productId, next.map((o) => o.id));
    if (!r.ok) return toast.error(apiError(r, 'Réordonnancement refusé.'));
  }
  async function removeOption(o: ProductOptionRow) {
    if (!window.confirm(`Supprimer l’option « ${o.name} » et ses choix ?`)) return;
    setBusy(`del-${o.id}`);
    const r = await deleteProductOption(token, o.id);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la suppression.'));
    toast.ok('Option supprimée.');
    if (expanded === o.id) setExpanded(null);
    await load();
  }

  // Les choix se gèrent dans <ChoicesEditor>, rendu pour l'option dépliée ci-dessous.

  return (
    <Panel
      title="Options & choix"
      sub="Options configurables vendables (ex. « Taille ») et leurs choix (ex. « M · +2 $ »)."
      className="mb"
    >
      {!adding && (
        <Button size="sm" onClick={() => setAdding(true)} disabled={busy === 'add-option'}>
          <IconPlus size={13} /> Ajouter une option
        </Button>
      )}
      {adding && (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          <div className="row" style={{ gap: 8 }}>
            <Field label="Nom de l'option">
              <Input value={oname} onChange={(e) => setOname(e.target.value)} placeholder="Taille" autoFocus />
            </Field>
            <label className="check-row" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 22 }}>
              <input type="checkbox" checked={orequired} onChange={(e) => setOrequired(e.target.checked)} />
              <span>Option requise</span>
            </label>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" disabled={busy === 'add-option'} onClick={addOption}>Créer</Button>
            <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>Annuler</Button>
          </div>
        </div>
      )}

      {options.length === 0 ? (
        <EmptyState>
          <div className="muted">Aucune option configurable pour ce produit.</div>
        </EmptyState>
      ) : (
        <div className="stack" style={{ gap: 8, marginTop: 12 }}>
          {options.map((o, i) => (
            <div key={o.id} className="card-block" style={{ border: '1px solid var(--border-soft)', borderRadius: 8 }}>
              <div className="row" style={{ alignItems: 'center', gap: 8, padding: '8px 12px' }}>
                {editId === o.id ? (
                  <div className="row" style={{ gap: 8, flex: 1 }}>
                    <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="input-sm" />
                    <label className="check-row" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" checked={editReq} onChange={(e) => setEditReq(e.target.checked)} />
                      <span>requis</span>
                    </label>
                    <Button size="sm" disabled={busy === `edit-${o.id}`} onClick={saveEdit}>OK</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditId(null)}>Annuler</Button>
                  </div>
                ) : (
                  <>
                    <Badge tone="violet">{o.name}</Badge>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {o.required ? 'requis' : 'optionnel'} · {o.choices.length} choix
                    </span>
                  </>
                )}
                <div className="row" style={{ marginLeft: 'auto', gap: 4 }}>
                  <Button size="sm" variant="secondary" onClick={() => setExpanded(expanded === o.id ? null : o.id)}>
                    {expanded === o.id ? <IconChevronDown size={13} /> : <IconChevronUp size={13} />}
                    {expanded === o.id ? 'Fermer' : 'Choix'}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={i === 0} title="Monter" onClick={() => moveOption(i, -1)}>
                    <IconChevronUp size={13} />
                  </Button>
                  <Button size="sm" variant="secondary" disabled={i === options.length - 1} title="Descendre" onClick={() => moveOption(i, 1)}>
                    <IconChevronDown size={13} />
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => startEdit(o)}>✎</Button>
                  <Button size="sm" variant="danger" disabled={busy === `del-${o.id}`} onClick={() => removeOption(o)}>
                    <IconTrash size={13} />
                  </Button>
                </div>
              </div>

              {expanded === o.id && <ChoicesEditor option={o} token={token} onDone={load} />}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Éditeur des choix d'une option dépliée. */
function ChoicesEditor({
  option,
  token,
  onDone,
}: {
  option: ProductOptionRow;
  token: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const [choices, setChoices] = useState(option.choices);
  const [busy, setBusy] = useState<string | null>(null);
  const [nl, setNl] = useState('');
  const [np, setNp] = useState('');
  const [adding, setAdding] = useState(false);

  // Re-synchronise après un rechargement du parent (ajout/suppression de choix).
  useEffect(() => {
    setChoices(option.choices);
  }, [option.choices]);

  async function addChoice() {
    if (!nl.trim()) return toast.error('Le libellé du choix est obligatoire.');
    const cents = Math.round(parseFloat(np.replace(',', '.')) * 100) || 0;
    setBusy('add-choice');
    const r = await createOptionChoice(token, option.id, {
      label: nl.trim(),
      priceDeltaHtCents: cents,
      sortOrder: choices.length,
    });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la création du choix.'));
    toast.ok('Choix ajouté.');
    setNl('');
    setNp('');
    setAdding(false);
    await onDone();
  }

  async function moveChoice(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= choices.length) return;
    const next = choices.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setChoices(next);
    const r = await reorderOptionChoices(token, option.id, next.map((c) => c.id));
    if (!r.ok) return toast.error(apiError(r, 'Réordonnancement refusé.'));
  }

  async function removeChoice(c: ChoiceRowLike) {
    if (!window.confirm(`Supprimer le choix « ${c.label} » ?`)) return;
    setBusy(`del-${c.id}`);
    const r = await deleteOptionChoice(token, c.id);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la suppression.'));
    toast.ok('Choix supprimé.');
    await onDone();
  }

  return (
    <div style={{ padding: '6px 12px 12px', borderTop: '1px solid var(--border-soft)' }}>
      <div className="stack" style={{ gap: 6 }}>
        {choices.map((c, i) => (
          <div key={c.id} className="row" style={{ alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, fontSize: 13 }}>{c.label}</span>
            <Badge tone="gray">{dollars(c.priceDeltaHtCents)} $</Badge>
            <div className="row" style={{ gap: 4 }}>
              <Button size="sm" variant="secondary" disabled={i === 0} title="Monter" onClick={() => moveChoice(i, -1)}>
                <IconChevronUp size={13} />
              </Button>
              <Button size="sm" variant="secondary" disabled={i === choices.length - 1} title="Descendre" onClick={() => moveChoice(i, 1)}>
                <IconChevronDown size={13} />
              </Button>
              <Button size="sm" variant="danger" disabled={busy === `del-${c.id}`} onClick={() => removeChoice(c)}>
                <IconTrash size={12} />
              </Button>
            </div>
          </div>
        ))}
        {!adding && (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <IconPlus size={12} /> Ajouter un choix
          </Button>
        )}
        {adding && (
          <div className="row" style={{ gap: 8 }}>
            <Input className="input-sm" value={nl} onChange={(e) => setNl(e.target.value)} placeholder="Libellé (ex. M)" autoFocus />
            <Input
              className="input-sm"
              value={np}
              onChange={(e) => setNp(e.target.value)}
              placeholder="+$ supplément"
              style={{ width: 120 }}
              inputMode="decimal"
            />
            <Button size="sm" disabled={busy === 'add-choice'} onClick={addChoice}>Ajouter</Button>
            <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>
              <IconX size={12} /> Annuler
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

type ChoiceRowLike = { id: string; label: string; priceDeltaHtCents: number; sortOrder: number };