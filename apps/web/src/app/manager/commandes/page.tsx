'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  confirmAdminOrderPayment,
  formatCents,
  getAdminOrder,
  listAdminOrders,
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TONE,
  type AdminOrderListItem,
  type OrderDetail,
  type OrderListPage,
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
  StatCard,
} from '@/components/ui';

type Phase = 'loading' | 'denied' | 'ready';

const PER_PAGE = 20;

/**
 * GO P4 (lot B1) — Commandes (ADMIN) : liste globale paginée + KPI agrégés
 * (compteurs et CA par statut) + détail avec confirmation de règlement
 * (virement rapproché) directement depuis l'UI — l'endpoint existait mais
 * n'était atteignable par aucune page.
 */
export default function ManagerOrdersPage() {
  const { phase: sessionPhase, me, token } = useAdminSession();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<OrderListPage<AdminOrderListItem> | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(
    async (t: string, p: number, st: string, search: string) => {
      const r = await listAdminOrders(t, {
        page: p,
        perPage: PER_PAGE,
        status: st || undefined,
        q: search || undefined,
      });
      if (!r.ok) {
        toast.error('Impossible de charger les commandes.');
        return;
      }
      setData(r.data);
    },
    [toast],
  );

  const openDetail = useCallback(
    async (id: string) => {
      setDetail(null);
      setDetailLoading(true);
      window.history.replaceState(null, '', `/manager/commandes?id=${encodeURIComponent(id)}`);
      const r = await getAdminOrder(token, id);
      setDetailLoading(false);
      if (!r.ok) {
        toast.error('Commande introuvable.');
        window.history.replaceState(null, '', '/manager/commandes');
        return;
      }
      setDetail(r.data);
    },
    [token, toast],
  );

  const closeDetail = useCallback(() => {
    setDetail(null);
    window.history.replaceState(null, '', '/manager/commandes');
  }, []);

  useEffect(() => {
    if (sessionPhase === 'loading') return;
    if (sessionPhase === 'denied') {
      setPhase('denied');
      return;
    }
    setPhase('ready');
    void (async () => {
      await load(token, 1, '', '');
      const id = new URLSearchParams(window.location.search).get('id');
      if (id) await openDetail(id);
    })();
  }, [sessionPhase, token, load, openDetail]);

  const changeStatus = (v: string) => {
    setStatus(v);
    setPage(1);
    void load(token, 1, v, q);
  };

  const search = () => {
    setPage(1);
    void load(token, 1, status, q);
  };

  /** Confirmation de règlement (virement rapproché) — acte ADMIN tracé. */
  const confirmPayment = async () => {
    if (!detail) return;
    setConfirming(true);
    const r = await confirmAdminOrderPayment(token, detail.id, {
      reference: 'CONFIRMED-MANAGER-UI',
    });
    setConfirming(false);
    if (!r.ok) {
      toast.error('Impossible de confirmer le règlement.');
      return;
    }
    const body = r.data as { alreadyConfirmed?: boolean; status?: string } | null;
    if (body?.alreadyConfirmed) {
      toast.info('Cette commande était déjà confirmée.');
    } else {
      toast.ok('Règlement confirmé — la commande a avancé.');
    }
    await load(token, page, status, q);
    await openDetail(detail.id);
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  const kpis = useMemo(() => {
    const s = data?.summary;
    const cnt = (st: string) => s?.statuses.find((x) => x.status === st)?.count ?? 0;
    return {
      pending: cnt('PENDING_PAYMENT'),
      paid: cnt('PAID') + cnt('PROVISIONING'),
      active: cnt('ACTIVE'),
      ttc: s?.totalTtcCents ?? 0,
    };
  }, [data?.summary]);

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

  const showDetail = detailLoading || detail !== null;

  return (
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }} activeHref="/manager/commandes">
      <div className="wrap-md">
        {!showDetail && (
          <>
            <PageIntro
              eyebrow="Administration"
              title="Commandes"
              sub="Toutes les commandes de la plateforme — vues agrégées, recherche et confirmation de règlement."
            />

            <div className="stats-grid" style={{ marginBottom: 16 }}>
              <StatCard label="En attente" value={kpis.pending} tone="amber" />
              <StatCard label="Payées / provisioning" value={kpis.paid} />
              <StatCard label="Actives" value={kpis.active} tone="info" />
              <StatCard label="CA TTC (filtre)" value={formatCents(kpis.ttc)} />
            </div>

            <div className="row mb">
              <Field label="Statut">
                <Select value={status} onChange={(e) => changeStatus(e.target.value)} className="select-sm">
                  <option value="">Tous</option>
                  {Object.entries(ORDER_STATUS_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Recherche">
                <Input
                  value={q}
                  placeholder="email, nom ou produit"
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
                  className="input-sm"
                />
              </Field>
              <div style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
                <Button size="sm" variant="secondary" onClick={search}>Filtrer</Button>
              </div>
              {data && (
                <span className="muted cell-sub" style={{ paddingBottom: 10 }}>
                  {data.total} commande(s)
                </span>
              )}
            </div>

            {!data || data.items.length === 0 ? (
              <EmptyState>Aucune commande.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Référence</th>
                      <th>Client</th>
                      <th>Produit</th>
                      <th>Montant TTC</th>
                      <th>Statut</th>
                      <th>Date</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.items ?? []).map((o) => (
                      <tr key={o.id}>
                        <td className="muted nowrap" title={o.id}>{o.id.slice(0, 10)}…</td>
                        <td className="nowrap">{o.customerEmail}</td>
                        <td>{o.productName}</td>
                        <td className="nowrap">
                          {formatCents(o.amountTtcCents)}{' '}
                          <span className="muted">{o.currency}</span>
                        </td>
                        <td>
                          <Badge tone={ORDER_STATUS_TONE[o.status] ?? 'neutral'}>
                            {ORDER_STATUS_LABEL[o.status] ?? o.status}
                          </Badge>
                        </td>
                        <td className="muted nowrap">
                          {new Date(o.createdAt).toLocaleDateString()}
                        </td>
                        <td className="nowrap" style={{ textAlign: 'right' }}>
                          <Button size="sm" variant="secondary" onClick={() => void openDetail(o.id)}>
                            Détail
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {data && data.total > data.perPage && (
              <div className="row mt">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={data.page <= 1}
                  onClick={() => {
                    const p = data.page - 1;
                    setPage(p);
                    void load(token, p, status, q);
                  }}
                >
                  ← Précédent
                </Button>
                <span className="muted cell-sub">Page {data.page} / {totalPages}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={data.page >= totalPages}
                  onClick={() => {
                    const p = data.page + 1;
                    setPage(p);
                    void load(token, p, status, q);
                  }}
                >
                  Suivant →
                </Button>
              </div>
            )}
          </>
        )}

        {showDetail && detailLoading && <PageLoading label="Chargement de la commande." />}

        {showDetail && !detailLoading && detail && (
          <>
            <button className="store-back" type="button" onClick={closeDetail}>
              ← Retour à la liste
            </button>

            <PageIntro
              eyebrow="Administration"
              title={detail.productName}
              sub={`Commande ${detail.id}`}
            />

            <Panel title="État">
              <div className="row mb">
                <Badge tone={ORDER_STATUS_TONE[detail.status] ?? 'neutral'}>
                  {ORDER_STATUS_LABEL[detail.status] ?? detail.status}
                </Badge>
                <span className="muted cell-sub">
                  Créée le {new Date(detail.createdAt).toLocaleString()}
                  {detail.paidAt ? ` — payée le ${new Date(detail.paidAt).toLocaleString()}` : ''}
                </span>
              </div>
              {detail.status === 'PENDING_PAYMENT' && (
                <div className="row">
                  <Button
                    size="sm"
                    onClick={() => void confirmPayment()}
                    disabled={confirming}
                  >
                    {confirming ? 'Confirmation…' : 'Confirmer le règlement (virement)'}
                  </Button>
                  <span className="muted cell-sub">
                    Acte ADMIN tracé (référence + audit) — idempotent.
                  </span>
                </div>
              )}
              {(detail.statusHistory ?? []).length > 0 && (
                <ol className="muted" style={{ margin: '12px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {(detail.statusHistory ?? []).map((h) => (
                    <li key={h.id}>
                      {new Date(h.createdAt).toLocaleString()} —{' '}
                      <b>{ORDER_STATUS_LABEL[h.status] ?? h.status}</b>
                      {h.actorEmail ? ` (par ${h.actorEmail})` : ''}
                      {h.note ? ` — ${h.note}` : ''}
                    </li>
                  ))}
                </ol>
              )}
            </Panel>

            <Panel title="Client & commande">
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 14 }}>
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Client</span>
                  <span>
                    {detail.customer?.name ?? detail.customerName} — {detail.customerEmail}
                    {detail.customer?.userId ? '' : ' (compte invité)'}
                  </span>
                </li>
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Total TTC</span>
                  <strong>{formatCents(detail.amountTtcCents)} {detail.currency}</strong>
                </li>
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Cycle</span>
                  <span>{detail.billingCycle}</span>
                </li>
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Moyen de paiement</span>
                  <span>{detail.paymentMethodName ?? '—'}</span>
                </li>
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Clé d’idempotence</span>
                  <span className="muted" title={detail.idempotencyKey ?? ''}>
                    {detail.idempotencyKey ? `${detail.idempotencyKey.slice(0, 16)}…` : '—'}
                  </span>
                </li>
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Abonnement lié</span>
                  <span>
                    {detail.subscription
                      ? `${detail.subscription.product?.slug ?? ''} (${detail.subscription.status})`
                      : '—'}
                  </span>
                </li>
              </ul>
            </Panel>

            {detail.invoice && (
              <Panel title="Facture émise">
                <div className="row">
                  <b>{detail.invoice.number}</b>
                  <Badge tone={detail.invoice.status === 'PAID' ? 'green' : 'amber'}>
                    {detail.invoice.status}
                  </Badge>
                  <a className="btn-secondary" href="/manager/factures">Voir les factures</a>
                </div>
              </Panel>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
