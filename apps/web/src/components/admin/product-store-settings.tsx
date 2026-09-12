'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  createCheckoutField,
  deleteCheckoutField,
  listCheckoutFields,
  reorderCheckoutFields,
  updateCheckoutField,
  updateProduct,
  updateStoreSettings,
  type ProductAdmin,
} from '@/lib/api';
import { useToast } from '@/components/toast';
import { Badge, Button, Field, Input, Panel, Select } from '@/components/ui';
import { IconChevronDown, IconChevronUp, IconPlus, IconTrash, IconX } from '@/components/icons';

type CheckoutFieldRow = {
  id: string;
  key: string;
  label: string;
  type: string;
  placeholder?: string | null;
  required: boolean;
  enabled: boolean;
  sortOrder: number;
};

const FIELD_TYPES = ['TEXT', 'EMAIL', 'TEL'];
const TYPE_LABEL: Record<string, string> = { TEXT: 'Texte', EMAIL: 'Email', TEL: 'Téléphone' };

function dollars(v?: number): string {
  return ((v ?? 0) / 100).toFixed(2);
}

/** Réglages « boutique » d'un produit (récap /cart + champs de facturation). */
export function StoreSettingsDrawer({
  product,
  token,
  onUpdated,
}: {
  product: ProductAdmin;
  token: string;
  onUpdated?: () => void;
}) {
  const toast = useToast();
  const [fields, setFields] = useState<CheckoutFieldRow[]>([]);
  const [allowEdit, setAllowEdit] = useState(product.allowEditConfig ?? true);
  const [installDollars, setInstallDollars] = useState(dollars(product.installationFeeCents));
  const [busy, setBusy] = useState(false);

  // ── Déploiement par défaut (app servie à la première commande) ────────────
  const [repoUrl, setRepoUrl] = useState(product.moduleParams?.repoUrl ?? '');
  const [branch, setBranch] = useState(product.moduleParams?.branch ?? '');
  const [buildPack, setBuildPack] = useState(product.moduleParams?.buildPack ?? '');
  const [publishDirectory, setPublishDirectory] = useState(product.moduleParams?.publishDirectory ?? '');
  const [isStatic, setIsStatic] = useState(!!product.moduleParams?.isStatic);
  const [provisionModuleId, setProvisionModuleId] = useState(product.provisionModuleId ?? '');
  const [depBusy, setDepBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [nl, setNl] = useState('');
  const [nt, setNt] = useState('TEXT');
  const [nr, setNr] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editType, setEditType] = useState('TEXT');
  const [editReq, setEditReq] = useState(false);

  async function load() {
    const r = await listCheckoutFields(token, product.id);
    if (r.ok) setFields((r.data as CheckoutFieldRow[]) ?? []);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  async function saveSettings() {
    setBusy(true);
    const cents = Math.round(parseFloat(installDollars || '0') * 100);
    const r = await updateStoreSettings(token, product.id, {
      allowEditConfig: allowEdit,
      installationFeeCents: Number.isFinite(cents) && cents >= 0 ? cents : 0,
    });
    setBusy(false);
    if (!r.ok) return toast.error(apiError(r, 'Échec de l’enregistrement des réglages.'));
    toast.ok('Réglages boutique enregistrés.');
    onUpdated?.();
  }

  async function saveDeployment() {
    setDepBusy(true);
    const r = await updateProduct(token, product.id, {
      moduleParams: {
        repoUrl: repoUrl.trim() || '',
        branch: branch.trim() || '',
        buildPack: buildPack.trim() || '',
        publishDirectory: publishDirectory.trim() || '',
        isStatic,
      },
      provisionModuleId: provisionModuleId.trim() || '',
    });
    setDepBusy(false);
    if (!r.ok) return toast.error(apiError(r, 'Échec de l’enregistrement du déploiement.'));
    toast.ok('Application par défaut enregistrée.');
    onUpdated?.();
  }

  async function toggleEnabled(f: CheckoutFieldRow, enabled: boolean) {
    setFields((s) => s.map((x) => (x.id === f.id ? { ...x, enabled } : x)));
    const r = await updateCheckoutField(token, f.id, { enabled });
    if (!r.ok) toast.error(apiError(r, 'Mise à jour du champ impossible.'));
  }

  async function removeField(f: CheckoutFieldRow) {
    if (!window.confirm(`Supprimer le champ « ${f.label} » ?`)) return;
    const r = await deleteCheckoutField(token, f.id);
    if (!r.ok) return toast.error(apiError(r, 'Suppression impossible.'));
    toast.ok('Champ supprimé.');
    void load();
  }

  async function move(i: number, dir: -1 | 1) {
    const target = i + dir;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    const tmp = next[i];
    next[i] = next[target];
    next[target] = tmp;
    setFields(next);
    const r = await reorderCheckoutFields(token, product.id, next.map((f) => f.id));
    if (!r.ok) toast.error(apiError(r, 'Réordonnancement impossible.'));
  }

  function startEdit(f: CheckoutFieldRow) {
    setEditingId(f.id);
    setEditLabel(f.label);
    setEditType(f.type);
    setEditReq(f.required);
  }

  async function saveEdit() {
    if (!editingId) return;
    if (!editLabel.trim()) return toast.error('Le libellé est obligatoire.');
    const r = await updateCheckoutField(token, editingId, {
      label: editLabel.trim(),
      type: editType,
      required: editReq,
    });
    if (!r.ok) return toast.error(apiError(r, 'Mise à jour impossible.'));
    toast.ok('Champ modifié.');
    setEditingId(null);
    void load();
  }

  async function addField() {
    if (!nl.trim()) return toast.error('Le libellé du champ est obligatoire.');
    const key = nl.trim().toLowerCase().replace(/\s+/g, '_');
    const r = await createCheckoutField(token, product.id, {
      key,
      label: nl.trim(),
      type: nt,
      required: nr,
      sortOrder: fields.length,
    });
    if (!r.ok) return toast.error(apiError(r, 'Ajout du champ impossible.'));
    toast.ok('Champ ajouté.');
    setNl(''); setNt('TEXT'); setNr(false); setAdding(false);
    void load();
  }

  return (
    <Panel title={`Boutique — ${product.name}`} sub="Contrôles du récap /cart et champs de facturation.">
      {/* Réglages généraux */}
      <div className="stack" style={{ gap: 14 }}>
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>Bouton « Modifier la configuration »</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Afficher le bouton permettant au client de revenir à la fiche depuis /cart.
            </div>
          </div>
          <label className="switch">
            <input type="checkbox" checked={allowEdit} onChange={(e) => setAllowEdit(e.target.checked)} />
            <span className="slider" />
          </label>
        </div>

        <Field label="Prix d'installation ($)">
          <Input
            type="number"
            min={0}
            step="0.01"
            value={installDollars}
            onChange={(e) => setInstallDollars(e.target.value)}
            placeholder="0.00"
          />
        </Field>

        <div>
          <Button onClick={() => void saveSettings()} disabled={busy}>
            {busy ? 'Enregistrement…' : 'Enregistrer les réglages'}
          </Button>
        </div>
      </div>

      {/* Déploiement par défaut (l'app servie à la première commande) */}
      <div className="section-title" style={{ marginTop: 22 }}>
        <h3>Application par défaut</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          App/site static déployé à la première commande de ce produit.
        </span>
      </div>
      <div className="stack" style={{ gap: 14 }}>
        <Field label="URL du dépôt / site à déployer" required>
          <Input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/merrabii/Code-Diali-Guide-de-Demarrage.git"
          />
        </Field>
        <div className="grid-form" style={{ gap: 10 }}>
          <Field label="Branche">
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
          </Field>
          <Field label="Build pack">
            <Input value={buildPack} onChange={(e) => setBuildPack(e.target.value)} placeholder="nixpacks" />
          </Field>
          <Field label="Dossier de publication (SPA)">
            <Input
              value={publishDirectory}
              onChange={(e) => setPublishDirectory(e.target.value)}
              placeholder="/dist (vite build)"
            />
          </Field>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <label className="switch">
              <input type="checkbox" checked={isStatic} onChange={(e) => setIsStatic(e.target.checked)} />
              <span className="slider" />
            </label>
            <span style={{ fontSize: 13 }}>Publier en statique (nginx)</span>
          </div>
          <Field label="Méthode de provisioning (id)">
            <Input
              value={provisionModuleId}
              onChange={(e) => setProvisionModuleId(e.target.value)}
              placeholder="id du ProvisionMethod (coolify-github…)"
            />
          </Field>
        </div>
        <div>
          <Button onClick={() => void saveDeployment()} disabled={depBusy}>
            {depBusy ? 'Enregistrement…' : 'Enregistrer l’application par défaut'}
          </Button>
        </div>
      </div>

      {/* Champs de facturation */}
      <div className="section-title" style={{ marginTop: 22 }}>
        <h3>Champs de facturation</h3>
        <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}>
          <IconPlus size={13} /> {adding ? 'Fermer' : 'Ajouter un champ'}
        </Button>
      </div>

      {adding && (
        <div className="stack" style={{ gap: 10, padding: '0 0 14px' }}>
          <div className="grid-form" style={{ gap: 10 }}>
            <Field label="Libellé" required>
              <Input value={nl} onChange={(e) => setNl(e.target.value)} placeholder="Société (optionnel)" />
            </Field>
            <Field label="Type">
              <Select value={nt} onChange={(e) => setNt(e.target.value)}>
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="row" style={{ gap: 14, alignItems: 'center' }}>
            <label className="row" style={{ gap: 6, fontSize: 13, alignItems: 'center' }}>
              <input type="checkbox" checked={nr} onChange={(e) => setNr(e.target.checked)} /> Requis
            </label>
            <Button size="sm" onClick={() => void addField()}>
              <IconPlus size={13} /> Ajouter
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              <IconX size={13} /> Annuler
            </Button>
          </div>
        </div>
      )}

      {fields.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          Aucun champ défini — les champs par défaut (nom, email, téléphone) seront utilisés au checkout.
        </p>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {fields.map((f, i) => (
            <div key={f.id} className="row" style={{ alignItems: 'center', gap: 10 }}>
              <div className="row" style={{ gap: 2 }}>
                <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => void move(i, -1)} title="Monter" aria-label="Monter">
                  <IconChevronUp size={14} />
                </Button>
                <Button size="sm" variant="ghost" disabled={i === fields.length - 1} onClick={() => void move(i, 1)} title="Descendre" aria-label="Descendre">
                  <IconChevronDown size={14} />
                </Button>
              </div>

              <label style={{ display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={f.enabled}
                  onChange={(e) => void toggleEnabled(f, e.target.checked)}
                  title={f.enabled ? 'Désactiver' : 'Activer'}
                />
              </label>

              <div style={{ flex: 1, minWidth: 0 }}>
                {editingId === f.id ? (
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <Input
                      style={{ flex: '1 1 140px', minWidth: 100 }}
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                    />
                    <Select style={{ width: 'auto' }} value={editType} onChange={(e) => setEditType(e.target.value)}>
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                      ))}
                    </Select>
                    <label className="row" style={{ gap: 5, fontSize: 12, alignItems: 'center' }}>
                      <input type="checkbox" checked={editReq} onChange={(e) => setEditReq(e.target.checked)} /> Requis
                    </label>
                    <Button size="sm" onClick={() => void saveEdit()}>OK</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      <IconX size={13} />
                    </Button>
                  </div>
                ) : (
                  <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 13.5 }}>{f.label}</span>
                    <Badge tone="violet">{TYPE_LABEL[f.type] ?? f.type}</Badge>
                    {f.required && <Badge tone="amber">requis</Badge>}
                    {!f.enabled && <Badge tone="neutral">désactivé</Badge>}
                    <span className="muted mono" style={{ fontSize: 11 }}>{f.key}</span>
                  </div>
                )}
              </div>

              <div className="row" style={{ gap: 4 }}>
                {editingId !== f.id && (
                  <Button size="sm" variant="ghost" onClick={() => startEdit(f)} title="Modifier le champ">✎</Button>
                )}
                <Button size="sm" variant="danger" onClick={() => void removeField(f)} title="Supprimer">
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