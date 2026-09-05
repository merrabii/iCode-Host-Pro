'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  createCategory,
  deleteCategory,
  listCategories,
  listPacks,
  PackAdmin,
  ProductCategory,
  updateCategory,
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
import { IconDatabase, IconPencil, IconPlus, IconTrash, IconX } from '@/components/icons';

const EMPTY = { name: '', description: '', displayOrder: '0', recommendedPackId: '' };

export default function ManagerCategoriesPage() {
  const { phase, me, token } = useAdminSession();
  const toast = useToast();
  const [categories, setCategories] = useState<ProductCategory[]>([]);
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
    const [c, p] = await Promise.all([listCategories(t), listPacks(t)]);
    if (c.ok) setCategories((c.data as ProductCategory[]) ?? []);
    else toast.error(apiError(c, 'Impossible de charger les catégories.'));
    if (p.ok) setPacks((p.data as PackAdmin[]) ?? []);
  }

  function resetForm() {
    setF({ ...EMPTY });
    setEditId(null);
    setShowForm(false);
  }

  function startEdit(c: ProductCategory) {
    setEditId(c.id);
    setF({
      name: c.name,
      description: c.description ?? '',
      displayOrder: String(c.displayOrder),
      recommendedPackId: c.recommendedPackId ?? '',
    });
    setShowForm(true);
  }

  function field(name: keyof typeof EMPTY, v: string) {
    setF((prev) => ({ ...prev, [name]: v }));
  }

  async function handleSave() {
    if (!f.name.trim()) return toast.error('Le nom de la catégorie est obligatoire.');
    const payload = {
      name: f.name.trim(),
      description: f.description.trim() || undefined,
      displayOrder: Number(f.displayOrder) || 0,
      recommendedPackId: f.recommendedPackId || undefined,
    };
    setBusy('save');
    const r = editId
      ? await updateCategory(token, editId, payload)
      : await createCategory(token, payload);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de l’enregistrement de la catégorie.'));
    toast.ok(editId ? 'Catégorie mise à jour.' : 'Catégorie créée.');
    resetForm();
    void load(token);
  }

  async function handleDelete(c: ProductCategory) {
    if (!window.confirm(`Supprimer la catégorie « ${c.name} » ?`)) return;
    setBusy(c.id);
    const r = await deleteCategory(token, c.id);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la suppression.'));
    toast.ok('Catégorie supprimée.');
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
          title="Catégories de produits"
          sub="Classification des offres. Un pack recommandé préremplit le formulaire produit sans l'imposer."
        >
          <Button onClick={() => setShowForm((v) => !v)}>
            {showForm ? <IconX size={14} /> : <IconPlus size={14} />}
            {showForm ? 'Fermer' : 'Nouvelle catégorie'}
          </Button>
        </PageIntro>

        {showForm && (
          <Panel
            title={editId ? 'Modifier la catégorie' : 'Nouvelle catégorie'}
            sub="Le pack recommandé est suggéré à la création d'un produit de cette catégorie."
            className="mb"
          >
            <form
              className="grid-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSave();
              }}
            >
              <Field label="Nom de la catégorie" required>
                <Input value={f.name} onChange={(e) => field('name', e.target.value)} placeholder="Hébergement web" />
              </Field>
              <Field label="Description">
                <Input value={f.description} onChange={(e) => field('description', e.target.value)} placeholder="Sites vitrines & apps légères" />
              </Field>
              <Field label="Ordre d'affichage">
                <Input type="number" min={0} step={1} value={f.displayOrder} onChange={(e) => field('displayOrder', e.target.value)} />
              </Field>
              <Field label="Pack recommandé">
                <Select value={f.recommendedPackId} onChange={(e) => field('recommendedPackId', e.target.value)}>
                  <option value="">Aucun</option>
                  {packs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.ramMb} Mo · {p.cpuCores} CPU
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid-form-actions">
                <Button type="submit" disabled={busy === 'save'}>
                  {editId ? <IconPencil size={14} /> : <IconPlus size={14} />}
                  {busy === 'save' ? 'Enregistrement…' : editId ? 'Enregistrer' : 'Créer la catégorie'}
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

        {categories.length === 0 ? (
          <EmptyState>
            <IconDatabase />
            <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Aucune catégorie</div>
            <div className="muted" style={{ fontSize: 13.5 }}>
              Créez votre première catégorie pour organiser le catalogue.
            </div>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th>Catégorie</th>
                  <th>Pack recommandé</th>
                  <th>Produits</th>
                  <th className="ta-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="cell-title">{c.name}</div>
                      {c.description && <div className="muted cell-sub">{c.description}</div>}
                    </td>
                    <td>
                      {c.recommendedPack ? (
                        <Badge tone="violet">
                          {c.recommendedPack.name} · {c.recommendedPack.ramMb} Mo ·{' '}
                          {c.recommendedPack.cpuCores} CPU
                        </Badge>
                      ) : (
                        <span className="muted">Aucun</span>
                      )}
                    </td>
                    <td>{c._count?.products ?? 0}</td>
                    <td>
                      <div className="row ta-right">
                        <Button size="sm" variant="secondary" disabled={busy === c.id} onClick={() => startEdit(c)} title="Modifier">
                          <IconPencil size={14} />
                        </Button>
                        <Button size="sm" variant="danger" disabled={busy === c.id} onClick={() => handleDelete(c)} title="Supprimer">
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