'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  apiError,
  createTaxRate,
  deleteTaxRate,
  listTaxRates,
  updateTaxRate,
  type TaxRateItem,
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
} from '@/components/ui';

type Phase = 'loading' | 'denied' | 'ready';

/**
 * GO P5 (décision §6-6, page dédiée) — Administration des taux de taxe :
 * CRUD complet avec UN SEUL `isDefault` (taux appliqué par défaut aux produits
 * sans taux), suppression refusée (409) tant qu'un produit y est rattaché,
 * nom unique (409). Aucun montant de prix ici : la taxe ne change jamais un
 * prix HT, uniquement le calcul de TVA.
 */
export default function ManagerTaxRatesPage() {
  const { phase: sessionPhase, me, token } = useAdminSession();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [rows, setRows] = useState<TaxRateItem[] | null>(null);
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (t: string) => {
      const r = await listTaxRates(t);
      if (!r.ok) {
        toast.error('Impossible de charger les taux de taxe.');
        return;
      }
      setRows(r.data);
    },
    [toast],
  );

  useEffect(() => {
    if (sessionPhase === 'loading') return;
    if (sessionPhase === 'denied') {
      setPhase('denied');
      return;
    }
    setPhase('ready');
    void load(token);
  }, [sessionPhase, token, load]);

  const resetForm = () => {
    setName('');
    setRate('');
    setIsDefault(false);
    setEditingId(null);
  };

  const startEdit = (row: TaxRateItem) => {
    setEditingId(row.id);
    setName(row.name);
    setRate(String(row.ratePercent));
    setIsDefault(row.isDefault);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const rateNum = Number(rate.trim().replace(',', '.'));
    if (!name.trim()) {
      toast.warn('Le nom est requis.');
      return;
    }
    if (!Number.isFinite(rateNum) || rateNum < 0 || rateNum > 100) {
      toast.warn('Le taux doit être compris entre 0 et 100 %.');
      return;
    }
    setBusy(true);
    const r = editingId
      ? await updateTaxRate(token, editingId, { name: name.trim(), ratePercent: rateNum, isDefault })
      : await createTaxRate(token, { name: name.trim(), ratePercent: rateNum, isDefault });
    setBusy(false);
    if (!r.ok) {
      toast.error(
        apiError(r, editingId ? 'Modification impossible.' : 'Création impossible.'),
      );
      return;
    }
    toast.ok(editingId ? 'Taux modifié.' : 'Taux ajouté.');
    resetForm();
    await load(token);
  };

  const makeDefault = async (row: TaxRateItem) => {
    const r = await updateTaxRate(token, row.id, { isDefault: true });
    if (!r.ok) {
      toast.error(apiError(r, 'Opération impossible.'));
      return;
    }
    toast.ok(`« ${row.name} » est maintenant le taux par défaut.`);
    await load(token);
  };

  const remove = async (row: TaxRateItem) => {
    if (!window.confirm(`Supprimer le taux « ${row.name} » ?`)) return;
    const r = await deleteTaxRate(token, row.id);
    if (!r.ok) {
      toast.error(apiError(r, 'Suppression impossible.'));
      return;
    }
    toast.ok('Taux supprimé.');
    await load(token);
  };

  if (sessionPhase === 'loading' || phase === 'loading') {
    return (
      <AppShell me={null} nav={ADMIN_NAV}>
        <PageLoading />
      </AppShell>
    );
  }

  if (sessionPhase === 'denied' || phase === 'denied') {
    return (
      <AppShell me={null} nav={ADMIN_NAV}>
        <Denied />
      </AppShell>
    );
  }

  return (
    <AppShell
      me={me}
      nav={ADMIN_NAV}
      tenant={{ label: 'Administration' }}
      activeHref="/manager/taxe"
    >
      <div className="wrap-md">
        <PageIntro
          eyebrow="Administration"
          title="Taux de taxe"
          sub="Taux de TVA utilisés par la boutique : un seul taux par défaut, appliqué aux produits sans taux imposé. La taxe ne modifie jamais un prix HT — uniquement le calcul TTC."
        />

        <Panel title="Taux enregistrés">
          {!rows || rows.length === 0 ? (
            <EmptyState>Aucun taux de taxe.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Nom</th>
                    <th>Taux</th>
                    <th>Par défaut</th>
                    <th>Produits liés</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="nowrap"><b>{row.name}</b></td>
                      <td className="nowrap">{Number(row.ratePercent)} %</td>
                      <td>
                        {row.isDefault ? (
                          <Badge tone="primary">Par défaut</Badge>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="muted nowrap">{row._count?.products ?? 0}</td>
                      <td className="nowrap" style={{ textAlign: 'right' }}>
                        {!row.isDefault && (
                          <Button size="sm" variant="secondary" onClick={() => void makeDefault(row)}>
                            Défaut
                          </Button>
                        )}{' '}
                        <Button size="sm" variant="secondary" onClick={() => startEdit(row)}>
                          Modifier
                        </Button>{' '}
                        <Button size="sm" variant="danger" onClick={() => void remove(row)}>
                          Supprimer
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title={editingId ? 'Modifier le taux' : 'Ajouter un taux'}
          sub={
            editingId
              ? 'Les produits déjà rattachés à ce taux suivent la modification immédiatement.'
              : 'Taux au format décimal accepté (20, 19.6, 0).'
          }
        >
          <form onSubmit={(e) => void submit(e)} className="row">
            <Field label="Nom" required htmlFor="tax-name">
              <Input
                id="tax-name"
                value={name}
                placeholder="TVA standard"
                onChange={(e) => setName(e.target.value)}
                className="input-sm"
              />
            </Field>
            <Field label="Taux (%)" required htmlFor="tax-rate">
              <Input
                id="tax-rate"
                value={rate}
                placeholder="20"
                inputMode="decimal"
                onChange={(e) => setRate(e.target.value)}
                className="input-sm"
              />
            </Field>
            <div style={{ alignSelf: 'flex-end', paddingBottom: 8 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                />
                Taux par défaut
              </label>
            </div>
            <div style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
              <Button type="submit" size="sm" disabled={busy}>
                {editingId ? 'Enregistrer' : 'Ajouter'}
              </Button>
              {editingId && (
                <>
                  {' '}
                  <Button type="button" size="sm" variant="secondary" onClick={resetForm}>
                    Annuler
                  </Button>
                </>
              )}
            </div>
          </form>
        </Panel>
      </div>
    </AppShell>
  );
}
