'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  apiError,
  listAdminPaymentMethods,
  updateAdminPaymentMethod,
  type AdminPaymentMethod,
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

type Phase = 'loading' | 'denied' | 'ready';

const TYPE_LABEL: Record<string, string> = {
  BANK_TRANSFER: 'Virement bancaire',
  MANUAL_TRANSFER: 'Transfert manuel',
  CARD: 'Carte bancaire',
};

const FEE_TYPE_LABEL: Record<string, string> = {
  NONE: 'Aucun',
  PERCENT: 'Pourcentage',
  FIXED: 'Fixe',
  PERCENT_AND_FIXED: 'Pourcentage + fixe',
};

const FEE_TYPE_KEYS = ['NONE', 'PERCENT', 'FIXED', 'PERCENT_AND_FIXED'];

/** Frais lisibles (le serveur expose `feePercent` en string décimale). */
function feeSummary(m: AdminPaymentMethod): string {
  const parts: string[] = [];
  if (m.feeType === 'PERCENT' || m.feeType === 'PERCENT_AND_FIXED') {
    parts.push(`${m.feePercent ?? '0'} %`);
  }
  if (m.feeType === 'FIXED' || m.feeType === 'PERCENT_AND_FIXED') {
    parts.push(`${m.feeFixedCents} cts`);
  }
  return parts.length ? parts.join(' + ') : '—';
}

/**
 * GO P9 (lot E1 / M-06) — écran « moyens de paiement » (ADMIN) : la gestion
 * (activer/désactiver, ordre d'affichage, config d'affichage non secrète,
 * frais) existait côté API sans AUCUNE interface, l'admin dépendait du
 * support dev. `configEnc` (secrets carte) n'est ni exposé ni modifiable ici —
 * seul `hasConfigEnc` est visible. Chaque PATCH est tracé `payment.method.update`
 * avec les VALEURS de frais (audit M-05 complété en P9a).
 */
export default function ManagerPaymentMethodsPage() {
  const { phase: sessionPhase, me, token } = useAdminSession();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [rows, setRows] = useState<AdminPaymentMethod[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [displayOrder, setDisplayOrder] = useState('0');
  const [feeType, setFeeType] = useState('NONE');
  const [feePercent, setFeePercent] = useState('');
  const [feeFixedCents, setFeeFixedCents] = useState('0');
  const [configText, setConfigText] = useState('{}');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (t: string) => {
      const r = await listAdminPaymentMethods(t);
      if (!r.ok) {
        toast.error('Impossible de charger les moyens de paiement.');
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
    setEditingId(null);
    setIsActive(true);
    setDisplayOrder('0');
    setFeeType('NONE');
    setFeePercent('');
    setFeeFixedCents('0');
    setConfigText('{}');
  };

  const startEdit = (row: AdminPaymentMethod) => {
    setEditingId(row.id);
    setIsActive(row.isActive);
    setDisplayOrder(String(row.displayOrder));
    setFeeType(FEE_TYPE_KEYS.includes(row.feeType) ? row.feeType : 'NONE');
    setFeePercent(row.feePercent ?? '');
    setFeeFixedCents(String(row.feeFixedCents ?? 0));
    setConfigText(JSON.stringify(row.config ?? {}, null, 2));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingId) return;

    const orderNum = Number(displayOrder.trim());
    if (!Number.isInteger(orderNum) || orderNum < 0) {
      toast.warn("L'ordre d'affichage doit être un entier ≥ 0.");
      return;
    }
    const percentNum = Number(feePercent.trim().replace(',', '.'));
    const needsPercent = feeType === 'PERCENT' || feeType === 'PERCENT_AND_FIXED';
    if (needsPercent && (!Number.isFinite(percentNum) || percentNum < 0 || percentNum > 100)) {
      toast.warn('Le pourcentage de frais doit être compris entre 0 et 100.');
      return;
    }
    const fixedNum = Number(feeFixedCents.trim());
    const needsFixed = feeType === 'FIXED' || feeType === 'PERCENT_AND_FIXED';
    if (needsFixed && (!Number.isInteger(fixedNum) || fixedNum < 0)) {
      toast.warn('Les frais fixes doivent être un entier ≥ 0 (en centimes).');
      return;
    }
    let configObj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(configText.trim() || '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        toast.warn('La config doit être un objet JSON ({ ... }).');
        return;
      }
      configObj = parsed as Record<string, unknown>;
    } catch {
      toast.warn('La config n’est pas un JSON valide.');
      return;
    }

    setBusy(true);
    const r = await updateAdminPaymentMethod(token, editingId, {
      isActive,
      displayOrder: orderNum,
      feeType,
      ...(needsPercent ? { feePercent: percentNum } : {}),
      ...(needsFixed ? { feeFixedCents: fixedNum } : {}),
      config: configObj,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(apiError(r, 'Modification impossible.'));
      return;
    }
    toast.ok('Moyen de paiement modifié.');
    resetForm();
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

  const editing = rows?.find((m) => m.id === editingId) ?? null;

  return (
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }} activeHref="/manager/moyens-paiement">
      <div className="wrap-md">
        <PageIntro
          eyebrow="Administration"
          title="Moyens de paiement"
          sub="Activation, ordre d'affichage, config d'affichage non secrète et frais — jamais les secrets de carte (configEnc)."
        />

        {editing && (
          <Panel title={`Modifier — ${editing.name}`}>
            <form onSubmit={submit}>
              <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
                <Field label="Actif">
                  <Select
                    value={isActive ? '1' : '0'}
                    onChange={(e) => setIsActive(e.target.value === '1')}
                    className="select-sm"
                  >
                    <option value="1">Oui (visible en checkout)</option>
                    <option value="0">Non (masqué)</option>
                  </Select>
                </Field>
                <Field label="Ordre d'affichage" hint="Entier ≥ 0 (croissant)">
                  <Input
                    type="number"
                    min={0}
                    value={displayOrder}
                    onChange={(e) => setDisplayOrder(e.target.value)}
                    className="input-sm"
                  />
                </Field>
                <Field label="Type de frais">
                  <Select value={feeType} onChange={(e) => setFeeType(e.target.value)} className="select-sm">
                    {FEE_TYPE_KEYS.map((k) => (
                      <option key={k} value={k}>{FEE_TYPE_LABEL[k]}</option>
                    ))}
                  </Select>
                </Field>
                {(feeType === 'PERCENT' || feeType === 'PERCENT_AND_FIXED') && (
                  <Field label="Frais en %" hint="0 à 100">
                    <Input
                      value={feePercent}
                      onChange={(e) => setFeePercent(e.target.value)}
                      className="input-sm"
                      placeholder="2.5"
                    />
                  </Field>
                )}
                {(feeType === 'FIXED' || feeType === 'PERCENT_AND_FIXED') && (
                  <Field label="Frais fixes (centimes)" hint="Entier ≥ 0">
                    <Input
                      type="number"
                      min={0}
                      value={feeFixedCents}
                      onChange={(e) => setFeeFixedCents(e.target.value)}
                      className="input-sm"
                    />
                  </Field>
                )}
              </div>
              <Field
                label="Config d'affichage (JSON non secret)"
                hint="Coordonnées de virement, instructions… — les secrets (configEnc) ne sont jamais exposés."
                className="mt"
              >
                <textarea
                  className="input"
                  rows={6}
                  spellCheck={false}
                  value={configText}
                  onChange={(e) => setConfigText(e.target.value)}
                  style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
                />
              </Field>
              <div className="row mt">
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? 'Enregistrement…' : 'Enregistrer'}
                </Button>
                <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={resetForm}>
                  Annuler
                </Button>
                {editing.hasConfigEnc && (
                  <span className="muted cell-sub">
                    Secrets de carte présents (configEnc) — jamais modifiables depuis cette page.
                  </span>
                )}
              </div>
            </form>
          </Panel>
        )}

        {!rows || rows.length === 0 ? (
          <EmptyState>Aucun moyen de paiement configuré.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Type</th>
                  <th>Actif</th>
                  <th>Ordre</th>
                  <th>Frais</th>
                  <th>Config</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td className="nowrap">{TYPE_LABEL[m.type] ?? m.type}</td>
                    <td>
                      <Badge tone={m.isActive ? 'green' : 'gray'}>{m.isActive ? 'Actif' : 'Inactif'}</Badge>
                    </td>
                    <td className="nowrap">{m.displayOrder}</td>
                    <td className="nowrap">
                      {feeSummary(m)}{' '}
                      <span className="muted">({FEE_TYPE_LABEL[m.feeType] ?? m.feeType})</span>
                    </td>
                    <td className="muted nowrap" title={JSON.stringify(m.config ?? {})}>
                      {m.config && Object.keys(m.config).length ? `${Object.keys(m.config).length} clé(s)` : '—'}
                      {m.hasConfigEnc ? ' + secrets' : ''}
                    </td>
                    <td className="nowrap" style={{ textAlign: 'right' }}>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={editingId === m.id || busy}
                        onClick={() => startEdit(m)}
                      >
                        Éditer
                      </Button>
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
