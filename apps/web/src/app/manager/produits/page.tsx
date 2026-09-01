'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  createProduct,
  deleteProduct,
  listProducts,
  ProductAdmin,
  updateProduct,
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
import { IconBox, IconPlus, IconX } from '@/components/icons';

const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'DISABLED'];

export default function ManagerProduitsPage() {
  const { phase, me, token } = useAdminSession();
  const toast = useToast();
  const [products, setProducts] = useState<ProductAdmin[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('generic');
  const [status, setStatus] = useState('DRAFT');
  const [busy, setBusy] = useState<string | null>(null); // 'create' | product id

  useEffect(() => {
    if (phase === 'ready' && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  async function load(t: string) {
    const r = await listProducts(t);
    if (!r.ok) return toast.error(apiError(r, 'Impossible de charger le catalogue.'));
    setProducts((r.data as ProductAdmin[]) ?? []);
  }

  async function handleCreate() {
    if (!name.trim()) return toast.error('Le nom du produit est obligatoire.');
    setBusy('create');
    const r = await createProduct(token, { name: name.trim(), kind, status });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la création du produit.'));
    toast.ok('Produit créé.');
    setName('');
    setKind('generic');
    setStatus('DRAFT');
    setShowCreate(false);
    void load(token);
  }

  async function handleDelete(p: ProductAdmin) {
    if (!window.confirm(`Supprimer le produit « ${p.name} » ?`)) return;
    setBusy(p.id);
    const r = await deleteProduct(token, p.id);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la suppression.'));
    toast.ok('Produit supprimé.');
    void load(token);
  }

  async function changeStatus(p: ProductAdmin, st: string) {
    setBusy(p.id);
    const r = await updateProduct(token, p.id, { status: st });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la mise à jour du statut.'));
    toast.ok('Statut du produit mis à jour.');
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
          title="Produits (catalogue)"
          sub="Offres de référence proposées aux clients. Le statut contrôle leur visibilité dans l’espace client."
        >
          <Button onClick={() => setShowCreate((v) => !v)}>
            <IconPlus size={14} />
            {showCreate ? 'Fermer le formulaire' : 'Nouveau produit'}
          </Button>
        </PageIntro>

        {showCreate && (
          <Panel title="Nouveau produit" sub="Ajouter une offre au catalogue de référence." className="mb">
            <form
              className="grid-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleCreate();
              }}
            >
              <Field label="Nom du produit" required>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Hébergement web — Starter" />
              </Field>
              <Field label="Type">
                <Input value={kind} onChange={(e) => setKind(e.target.value)} placeholder="generic" />
              </Field>
              <Field label="Statut initial">
                <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                  {PRODUCT_STATUSES.map((st) => (
                    <option key={st} value={st}>{st}</option>
                  ))}
                </Select>
              </Field>
              <div className="grid-form-actions">
                <Button type="submit" disabled={busy === 'create'}>
                  <IconPlus size={14} />
                  {busy === 'create' ? 'Création…' : 'Créer le produit'}
                </Button>
                <Button variant="secondary" onClick={() => setShowCreate(false)}>
                  Annuler
                </Button>
              </div>
            </form>
          </Panel>
        )}

        {products.length === 0 ? (
          <EmptyState>
            <IconBox />
            <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Catalogue vide</div>
            <div className="muted" style={{ fontSize: 13.5 }}>
              Ajoutez votre première offre via « Nouveau produit ».
            </div>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th>Produit</th>
                  <th>Type</th>
                  <th>Statut</th>
                  <th className="ta-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="cell-title">{p.name}</div>
                      <div className="muted mono cell-sub">{p.id.slice(0, 10)}…</div>
                    </td>
                    <td>
                      <Badge tone="violet">{p.kind || 'generic'}</Badge>
                    </td>
                    <td>
                      <Select
                        className="select-sm"
                        value={p.status}
                        disabled={busy === p.id}
                        onChange={(e) => changeStatus(p, e.target.value)}
                        aria-label="statut"
                        style={{ minWidth: 150 }}
                      >
                        {PRODUCT_STATUSES.map((st) => (
                          <option key={st} value={st}>{st}</option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      <div className="row ta-right">
                        <Button size="sm" variant="danger" disabled={busy === p.id} onClick={() => handleDelete(p)} title="Supprimer le produit">
                          <IconX size={14} />
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
