'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  apiError,
  updateProduct,
  type DeploymentModule,
  type PackAdmin,
  type ProductAdmin,
  type ProductCategory,
} from '@/lib/api';
import { useToast } from '@/components/toast';
import { Badge, Button, Field, Input, Panel, Select } from '@/components/ui';

const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'DISABLED'];

/** Étiquette courte du type de module (A = projet partagé, B = projet client dédié). */
function moduleKindLabel(kind?: string): string {
  return kind === 'SHARED_PROJECT' ? 'A · projet partagé' : 'B · projet client dédié';
}

function resolveModule(
  pack?: ProductAdmin['pack'] | PackAdmin | null,
  modules?: DeploymentModule[],
): DeploymentModule | undefined {
  const id = (pack && 'deploymentModuleId' in pack ? pack.deploymentModuleId : undefined) ?? pack?.deploymentModule?.id;
  if (!id) return undefined;
  return modules?.find((m) => m.id === id);
}

/** Chaîne résolue par le bouton « Créer un nouveau projet » pour un produit. */
function ChainStep({
  label,
  tone,
  hint,
  children,
}: {
  label: string;
  tone?: 'green' | 'blue' | 'amber' | 'neutral' | 'gray' | 'red';
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }} title={hint}>
      <span className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </span>
      <Badge tone={tone}>
        <span
          style={{
            display: 'inline-block',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 200,
            verticalAlign: 'middle',
          }}
        >
          {children}
        </span>
      </Badge>
    </div>
  );
}

function Arrow() {
  return <span style={{ color: 'var(--text-tertiary)', alignSelf: 'center' }}>→</span>;
}

/** Édition d'un produit existant + visualisation de la « méthode » du bouton
 *  « Créer un nouveau projet » (produit → pack → module → serveur). */
export function ProductEditPanel({
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
  const toast = useToast();
  const [name, setName] = useState(product.name);
  const [kind, setKind] = useState(product.kind ?? 'generic');
  const [status, setStatus] = useState(product.status);
  const [catId, setCatId] = useState(product.categoryId ?? '');
  const [packId, setPackId] = useState(product.packId ?? '');
  const [busy, setBusy] = useState(false);

  // Pack sélectionné pour la prévisualisation (PackAdmin, plus riche que product.pack).
  const chosenPack = packs.find((p) => p.id === packId) ?? product.pack ?? null;
  const mod = resolveModule(chosenPack, modules);
  const serverHost = mod?.server?.hostname || '—';

  // Ressources effectives appliquées à l'app : l'override du module prime sur le pack.
  const overrideActive = mod != null && (mod.overrideRamMb != null || mod.overrideCpuCores != null);
  const effRam = mod?.overrideRamMb ?? chosenPack?.ramMb;
  const effCpu = mod?.overrideCpuCores ?? chosenPack?.cpuCores;
  const effLabel = effRam != null && effCpu != null ? `${effRam} Mo · ${effCpu} CPU` : '—';

  async function save() {
    if (!name.trim()) return toast.error('Le nom du produit est obligatoire.');
    setBusy(true);
    const r = await updateProduct(token, product.id, {
      name: name.trim(),
      kind: kind.trim() || 'generic',
      status,
      categoryId: catId || null,
      packId: packId || null,
    });
    setBusy(false);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la mise à jour du produit.'));
    toast.ok('Produit mis à jour.');
    onUpdated?.();
  }

  return (
    <Panel title={`Modifier — ${product.name}`} sub="Modifier les champs du produit existant et voir la méthode utilisée par « Créer un nouveau projet »." className="mb">
      {/* Général — répare la modification des champs du produit existant */}
      <div className="stack" style={{ gap: 14 }}>
        <form
          className="grid-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Nom du produit" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Hébergement web — Starter" />
          </Field>
          <Field label="Type">
            <Input value={kind} onChange={(e) => setKind(e.target.value)} placeholder="generic" />
          </Field>
          <Field label="Statut">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              {PRODUCT_STATUSES.map((st) => (
                <option key={st} value={st}>{st}</option>
              ))}
            </Select>
          </Field>
          <Field label="Catégorie">
            <Select value={catId} onChange={(e) => setCatId(e.target.value)}>
              <option value="">Aucune</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
          <div className="grid-form-actions">
            <Button type="submit" disabled={busy}>
              {busy ? 'Enregistrement…' : 'Enregistrer le produit'}
            </Button>
          </div>
        </form>
      </div>

      {/* Méthode du bouton « Créer un nouveau projet » */}
      <div className="section-title" style={{ marginTop: 22 }}>
        <h3>Méthode de « Créer un nouveau projet »</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          Ce que le bouton utilise réellement, une fois un abonnement ACTIVE souscrit pour ce produit.
        </span>
      </div>

      <div
        className="row"
        style={{
          gap: 10,
          padding: 14,
          borderRadius: 10,
          border: '1px solid var(--border-soft)',
          background: 'var(--card-bg-2)',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
        }}
      >
        <ChainStep label="Produit">{product.name || '—'}</ChainStep>
        <Arrow />
        <ChainStep label="Pack" hint={chosenPack ? `${chosenPack.ramMb} Mo · ${chosenPack.cpuCores} CPU` : undefined}>
          {chosenPack?.name || '—'}
        </ChainStep>
        <Arrow />
        <ChainStep label="Module" hint={overrideActive ? 'Override RAM/CPU actif — prime sur le pack' : undefined}>
          {mod ? `${mod.code} · ${moduleKindLabel(mod.kind)}` : '—'}
        </ChainStep>
        <Arrow />
        <ChainStep label="Serveur">{serverHost}</ChainStep>
        <Arrow />
        <ChainStep
          label="Ressources appliquées"
          tone={overrideActive ? 'amber' : 'green'}
          hint={overrideActive ? `${mod!.overrideRamMb ?? '—'} Mo · ${mod!.overrideCpuCores ?? '—'} CPU (override du module prime sur le pack)` : undefined}
        >
          {effLabel}
        </ChainStep>
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Au clic, un abonnement ACTIVE de ce produit est résolu : le <strong>pack du produit</strong> → le{' '}
        <strong>module de déploiement</strong> lié à ce pack → le <strong>serveur</strong> du module. Les{' '}
        <strong>ressources appliquées</strong> viennent du pack, sauf si le module définit un{' '}
        <em>override RAM/CPU</em> (il prime alors sur le pack). Modifier le pack ci-dessous change donc la méthode
        utilisée.
      </p>

      <div style={{ marginTop: 12 }}>
        <Field label="Pack (change la méthode)">
          <Select value={packId} onChange={(e) => setPackId(e.target.value)}>
            <option value="">Aucun</option>
            {packs.map((pk) => (
              <option key={pk.id} value={pk.id}>
                {pk.name} — {pk.ramMb} Mo · {pk.cpuCores} CPU
              </option>
            ))}
          </Select>
        </Field>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          La liaison <strong>pack → module</strong> et le <strong>module → serveur</strong> se modifient sur la page{' '}
          <Link href="/manager/packs" className="link" style={{ color: 'var(--active-text)' }}>Packs et modules</Link>.
          Cette fiche visualise la chaîne et permet de choisir le pack du produit.
        </div>
      </div>
    </Panel>
  );
}