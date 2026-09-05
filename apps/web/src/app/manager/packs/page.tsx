'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  createPack,
  deletePack,
  listPacks,
  PackAdmin,
  updatePack,
} from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import {
  Badge,
  Button,
  Denied,
  EmptyState,
  Field,
  Input,
  PageIntro,
  PageLoading,
  Panel,
  Select,
} from '@/components/ui';
import { IconLayers, IconPencil, IconPlus, IconTrash, IconX } from '@/components/icons';

const PACK_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'DISABLED'];
const EMPTY = { name: '', description: '', ramMb: '', cpuCores: '1', diskGb: '', bandwidth: '' };

export default function ManagerPacksPage() {
  const { phase, me, token } = useAdminSession();
  const toast = useToast();
  const [packs, setPacks] = useState<PackAdmin[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [f, setF] = useState({ ...EMPTY });

  useEffect(() => {
    if (phase === 'ready' && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  async function load(t: string) {
    const r = await listPacks(t);
    if (!r.ok) return toast.error(apiError(r, 'Impossible de charger les packs.'));
    setPacks((r.data as PackAdmin[]) ?? []);
  }

  function resetForm() {
    setF({ ...EMPTY });
    setEditId(null);
    setShowForm(false);
  }

  function startEdit(p: PackAdmin) {
    setEditId(p.id);
    setF({
      name: p.name,
      description: p.description ?? '',
      ramMb: String(p.ramMb),
      cpuCores: String(p.cpuCores),
      diskGb: p.diskGb != null ? String(p.diskGb) : '',
      bandwidth: p.bandwidth ?? '',
    });
    setShowForm(true);
  }

  function field(name: keyof typeof EMPTY, v: string) {
    setF((prev) => ({ ...prev, [name]: v }));
  }

  async function handleSave() {
    if (!f.name.trim()) return toast.error('Le nom du pack est obligatoire.');
    const ramMb = Number(f.ramMb);
    if (!Number.isInteger(ramMb) || ramMb < 1)
      return toast.error('RAM (Mo) : entier positif requis.');
    const cpuCores = f.cpuCores.trim() === '' ? 1 : Number(f.cpuCores);
    if (!Number.isFinite(cpuCores) || cpuCores <= 0)
      return toast.error('CPU (cœurs) : nombre strictement positif requis.');
    const diskGb = f.diskGb.trim() === '' ? null : Number(f.diskGb);
    if (diskGb != null && (!Number.isInteger(diskGb) || diskGb < 1))
      return toast.error('Disque (Go) : entier >= 1 requis.');
    const payload = {
      name: f.name.trim(),
      description: f.description.trim() || undefined,
      ramMb,
      cpuCores,
      diskGb,
      bandwidth: f.bandwidth.trim() || undefined,
    };
    setBusy('save');
    const r = editId
      ? await updatePack(token, editId, payload)
      : await createPack(token, payload);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de l’enregistrement du pack.'));
    toast.ok(editId ? 'Pack mis à jour.' : 'Pack créé.');
    resetForm();
    void load(token);
  }

  async function changeStatus(p: PackAdmin, st: string) {
    setBusy(p.id);
    const r = await updatePack(token, p.id, { status: st });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la mise à jour.'));
    toast.ok('Statut du pack mis à jour.');
    void load(token);
  }

  async function handleDelete(p: PackAdmin) {
    if (!window.confirm(`Supprimer le pack « ${p.name} » ?`)) return;
    setBusy(p.id);
    const r = await deletePack(token, p.id);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la suppression.'));
    toast.ok('Pack supprimé.');
    void load(token);
  }

  if (phase === 'loading') {
    return (
      <AppShell me={null} nav={ADMIN_NAV}>
        <PageLoading />
      </AppShell>
    );
  }
  if (phase === 'denied') {
    return (
      <AppShell me={null} nav={ADMIN_NAV}>
        <Denied />
      </AppShell>
    );
  }

  return (
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }}>
      <div className="wrap-md">
        <PageIntro
          eyebrow="Administration"
          title="Packs (limites de ressources)"
          sub="Gabarits de ressources assignés aux produits. La RAM + CPU d'un pack ACTIVE sont appliquées à l'app de l'utilisateur lors d'un déploiement sur Coolify."
        >
          <Button onClick={() => setShowForm((v) => !v)}>
            {showForm ? <IconX size={14} /> : <IconPlus size={14} />}
            {showForm ? 'Fermer' : 'Nouveau pack'}
          </Button>
        </PageIntro>

        {showForm && (
          <Panel
            title={editId ? 'Modifier le pack' : 'Nouveau pack'}
            sub="RAM et CPU pilotent les limites appliquées à l'app ; disque et bande passante sont informatifs."
            className="mb"
          >
            <form
              className="grid-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSave();
              }}
            >
              <Field label="Nom du pack" required>
                <Input value={f.name} onChange={(e) => field('name', e.target.value)} placeholder="Starter 1 Go" />
              </Field>
              <Field label="Description">
                <Input value={f.description} onChange={(e) => field('description', e.target.value)} placeholder="Petite app / site vitrine" />
              </Field>
              <Field label="RAM (Mo)" required>
                <Input type="number" min={1} step={256} value={f.ramMb} onChange={(e) => field('ramMb', e.target.value)} placeholder="1024" />
              </Field>
              <Field label="CPU (cœurs)">
                <Input type="number" min={0.25} step={0.25} value={f.cpuCores} onChange={(e) => field('cpuCores', e.target.value)} placeholder="1" />
              </Field>
              <Field label="Disque (Go)">
                <Input type="number" min={1} step={1} value={f.diskGb} onChange={(e) => field('diskGb', e.target.value)} placeholder="20" />
              </Field>
              <Field label="Bande passante">
                <Input value={f.bandwidth} onChange={(e) => field('bandwidth', e.target.value)} placeholder="1 To / mois" />
              </Field>
              <div className="grid-form-actions">
                <Button type="submit" disabled={busy === 'save'}>
                  {editId ? <IconPencil size={14} /> : <IconPlus size={14} />}
                  {busy === 'save' ? 'Enregistrement…' : editId ? 'Enregistrer' : 'Créer le pack'}
                </Button>
                {editId && (
                  <Button variant="secondary" onClick={resetForm}>
                    Annuler
                  </Button>
                )}
              </div>
            </form>
          </Panel>
        )}

        {packs.length === 0 ? (
          <EmptyState>
            <IconLayers />
            <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Aucun pack</div>
            <div className="muted" style={{ fontSize: 13.5 }}>
              Créez votre premier gabarit de ressources via « Nouveau pack ».
            </div>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th>Pack</th>
                  <th>RAM</th>
                  <th>CPU</th>
                  <th>Disque</th>
                  <th>Bande passante</th>
                  <th>Produits</th>
                  <th>Statut</th>
                  <th className="ta-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {packs.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="cell-title">{p.name}</div>
                      {p.description && <div className="muted cell-sub">{p.description}</div>}
                    </td>
                    <td><Badge tone="violet">{p.ramMb} Mo</Badge></td>
                    <td>{p.cpuCores} cœurs</td>
                    <td>{p.diskGb != null ? `${p.diskGb} Go` : '—'}</td>
                    <td>{p.bandwidth ?? '—'}</td>
                    <td>{p._count?.products ?? 0}</td>
                    <td>
                      <Select
                        className="select-sm"
                        value={p.status}
                        disabled={busy === p.id}
                        onChange={(e) => changeStatus(p, e.target.value)}
                        aria-label="statut"
                        style={{ minWidth: 130 }}
                      >
                        {PACK_STATUSES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      <div className="row ta-right">
                        <Button size="sm" variant="secondary" disabled={busy === p.id} onClick={() => startEdit(p)} title="Modifier">
                          <IconPencil size={14} />
                        </Button>
                        <Button size="sm" variant="danger" disabled={busy === p.id} onClick={() => handleDelete(p)} title="Supprimer">
                          <IconTrash size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}