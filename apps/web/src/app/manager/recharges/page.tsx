'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  apiError,
  fetchRechargeProofBlob,
  listAdminRecharges,
  rejectAdminRecharge,
  validateAdminRecharge,
  WALLET_STATUS_LABEL,
  WALLET_STATUS_TONE,
  type RechargeItem,
  type RechargePage,
  type WalletTxStatus,
} from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  PageIntro,
  PageLoading,
  Panel,
  Select,
  StatCard,
} from '@/components/ui';

type Phase = 'loading' | 'denied' | 'ready';

const PER_PAGE = 20;

/**
 * GO P6 (lot C3a) — Validation des recharges par virement (ADMIN) : chaque
 * dépôt client est `PENDING` (0 crédit) ; « Valider » crédite le portefeuille
 * EXACTEMENT une fois (CAS serveur PENDING → SUCCEEDED, revalidation → 409),
 * « Rejeter » annule sans crédit (motif conservé). Le justificatif s’ouvre en
 * flux (admin uniquement).
 */
export default function ManagerRechargesPage() {
  const { phase: sessionPhase, me, token } = useAdminSession();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [data, setData] = useState<RechargePage | null>(null);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (t: string, p: number, st: string, search: string) => {
      const [list, pending] = await Promise.all([
        listAdminRecharges(t, {
          page: p,
          perPage: PER_PAGE,
          status: (st || undefined) as WalletTxStatus | undefined,
          q: search.trim() || undefined,
        }),
        listAdminRecharges(t, { page: 1, perPage: 1, status: 'PENDING' }),
      ]);
      if (list.ok) setData(list.data);
      else toast.error(apiError(list, 'Impossible de charger les recharges.'));
      if (pending.ok && pending.data) setPendingTotal(pending.data.total);
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
    void load(token, 1, '', '');
  }, [sessionPhase, token, load]);

  const applyFilters = (st: string, search: string) => {
    setStatus(st);
    setQ(search);
    setPage(1);
    void load(token, 1, st, search);
  };

  const changePage = (p: number) => {
    setPage(p);
    void load(token, p, status, q);
  };

  const validate = async (row: RechargeItem) => {
    if (
      !window.confirm(
        `Créditer ${row.customer.email} de ${(row.amountCents / 100).toFixed(2)} ${row.currency} (réf. ${row.reference}) ?`,
      )
    ) {
      return;
    }
    setBusyId(row.id);
    const r = await validateAdminRecharge(token, row.id);
    setBusyId(null);
    if (!r.ok) {
      toast.error(apiError(r, 'Validation impossible.'));
      await load(token, page, status, q);
      return;
    }
    toast.ok(`Recharge créditée — nouveau solde ${r.data ? (r.data.balanceCents / 100).toFixed(2) : ''} ${row.currency}.`);
    await load(token, page, status, q);
  };

  const reject = async (row: RechargeItem) => {
    const reason = window.prompt(
      `Motif du rejet de la recharge ${row.reference} (aucun montant ne sera crédité) :`,
    );
    if (reason === null) return;
    setBusyId(row.id);
    const r = await rejectAdminRecharge(token, row.id, reason.trim() || undefined);
    setBusyId(null);
    if (!r.ok) {
      toast.error(apiError(r, 'Rejet impossible.'));
      await load(token, page, status, q);
      return;
    }
    toast.ok('Recharge rejetée — aucun crédit appliqué.');
    await load(token, page, status, q);
  };

  const openProof = async (row: RechargeItem) => {
    setBusyId(row.id);
    const r = await fetchRechargeProofBlob(token, row.id);
    setBusyId(null);
    if (!r.ok || !r.blob) {
      toast.error('Justificatif introuvable.');
      return;
    }
    const url = URL.createObjectURL(r.blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
        <EmptyState>Accès réservé aux administrateurs.</EmptyState>
      </AppShell>
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  return (
    <AppShell
      me={me}
      nav={ADMIN_NAV}
      tenant={{ label: 'Administration' }}
      activeHref="/manager/recharges"
    >
      <div className="wrap-md">
        <PageIntro
          eyebrow="Administration"
          title="Recharges par virement"
          sub="Dépôts déposés par les clients avec justificatif. « Valider » crédite le portefeuille une seule fois (toute seconde validation est refusée) ; « Rejeter » annule sans crédit — le motif et le justificatif sont conservés."
        />

        <div className="grid-2 mb">
          <StatCard
            label="En attente de contrôle"
            value={pendingTotal}
            sub="Dépôts non traités"
            icon={<span aria-hidden>⏳</span>}
          />
          <Panel
            title="Filtres"
            sub={data ? `${data.total} recharge(s) pour ce filtre` : undefined}
          >
            <form
              className="row"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                applyFilters(status, q);
              }}
            >
              <Field label="Statut" htmlFor="rc-status">
                <Select
                  id="rc-status"
                  value={status}
                  onChange={(e) => applyFilters(e.target.value, q)}
                  className="select-sm"
                >
                  <option value="">Tous (hors échecs)</option>
                  <option value="PENDING">En attente</option>
                  <option value="SUCCEEDED">Créditées</option>
                  <option value="CANCELED">Rejetées</option>
                </Select>
              </Field>
              <Field label="Recherche" htmlFor="rc-q">
                <Input
                  id="rc-q"
                  value={q}
                  placeholder="Référence, note ou client…"
                  onChange={(e) => setQ(e.target.value)}
                  className="input-sm"
                />
              </Field>
              <div style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
                <Button type="submit" size="sm" variant="secondary">
                  Filtrer
                </Button>
              </div>
            </form>
          </Panel>
        </div>

        <Panel title="Dépôts">
          {!data || data.items.length === 0 ? (
            <EmptyState>Aucune recharge pour ce filtre.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Déposée le</th>
                    <th>Client</th>
                    <th>Référence</th>
                    <th style={{ textAlign: 'right' }}>Montant</th>
                    <th>Statut</th>
                    <th>Note</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr key={row.id}>
                      <td className="nowrap">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="nowrap">
                        <b>{row.customer.name || row.customer.email}</b>
                        {row.customer.name && (
                          <div className="muted" style={{ fontSize: 12 }}>
                            {row.customer.email}
                          </div>
                        )}
                      </td>
                      <td className="nowrap mono">{row.reference}</td>
                      <td className="nowrap" style={{ textAlign: 'right', fontWeight: 600 }}>
                        {(row.amountCents / 100).toFixed(2)} {row.currency}
                      </td>
                      <td className="nowrap">
                        <Badge tone={WALLET_STATUS_TONE[row.status] ?? 'neutral'}>
                          {WALLET_STATUS_LABEL[row.status] ?? row.status}
                        </Badge>
                        {row.adminActorEmail && row.status !== 'PENDING' && (
                          <div className="muted" style={{ fontSize: 12 }}>
                            par {row.adminActorEmail}
                          </div>
                        )}
                      </td>
                      <td className="muted">
                        {row.note ?? '—'}
                        {row.processedAt && (
                          <div style={{ fontSize: 12 }}>
                            traitée le {new Date(row.processedAt).toLocaleString()}
                          </div>
                        )}
                      </td>
                      <td className="nowrap" style={{ textAlign: 'right' }}>
                        {row.proofFileName && (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busyId === row.id}
                              onClick={() => void openProof(row)}
                            >
                              Justificatif
                            </Button>{' '}
                          </>
                        )}
                        {row.status === 'PENDING' && (
                          <>
                            <Button
                              size="sm"
                              disabled={busyId === row.id}
                              onClick={() => void validate(row)}
                            >
                              Valider
                            </Button>{' '}
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={busyId === row.id}
                              onClick={() => void reject(row)}
                            >
                              Rejeter
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {totalPages > 1 && (
            <div className="row" style={{ marginTop: 12 }}>
              <Button
                size="sm"
                variant="secondary"
                disabled={page <= 1}
                onClick={() => changePage(page - 1)}
              >
                Précédent
              </Button>{' '}
              <Button
                size="sm"
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => changePage(page + 1)}
              >
                Suivant
              </Button>
            </div>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}
