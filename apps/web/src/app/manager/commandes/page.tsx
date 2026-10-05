'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  adminCancelProvisioning,
  adminFinalizeOrder,
  adminProvisionOrder,
  adminResyncLimits,
  adminTerminateOrder,
  apiError,
  confirmAdminOrderPayment,
  createAdminRefund,
  formatCents,
  getAdminOrder,
  listAdminOrders,
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TONE,
  type AdminOrderListItem,
  type ApiResult,
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
 * GO P9 (lot E1 / M-06) — une des 5 actions admin sur commande. `needsReason`
 * impose un motif ≥ 8 caractères (les DTO serveur l'exigent déjà : tracé dans
 * OrderStatusHistory + AuditLog).
 */
type OrderActionDef = { key: string; label: string; hint: string; needsReason: boolean };

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
  // P9 (E1) — sélection d'une action admin à motif (annulation/terminaison/
  // finalisation), le reste s'exécute directement au clic.
  const [pendingAction, setPendingAction] = useState<OrderActionDef | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  // GO Q9 — remboursement wallet : montant en unités (converti en cents) +
  // émission optionnelle d'un avoir (facture de crédit AV-).
  const [refundAmount, setRefundAmount] = useState('');
  const [refundCreditNote, setRefundCreditNote] = useState(false);

  /** Les 5 actions admin (M-06) exposées selon l'état réel de la commande. */
  const actionsFor = (o: OrderDetail): OrderActionDef[] => {
    const list: OrderActionDef[] = [];
    if (o.status === 'PAID') {
      list.push({
        key: 'provision',
        label: 'Relancer le provisioning',
        hint: 'Réessaie l’exécution de la commande payée (idempotent).',
        needsReason: false,
      });
      list.push({
        key: 'finalize',
        label: 'Finaliser (C4)',
        hint: 'Finalisation d’une commande C3 prête : la preuve provider est relue côté serveur.',
        needsReason: true,
      });
      list.push({
        key: 'refund',
        label: 'Rembourser (wallet)',
        hint: 'Crédite le portefeuille du client dans la même transaction — plafond = montant encaissé, idempotent (clé unique). La carte réelle reste désactivée (aucun remboursement bancaire externe).',
        needsReason: true,
      });
    }
    // Le remboursement reste possible après provisionnement (ACTIVE) : le
    // serveur gate sur `paidAt`, pas sur le statut de service.
    if (o.status === 'ACTIVE') {
      list.push({
        key: 'refund',
        label: 'Rembourser (wallet)',
        hint: 'Crédite le portefeuille du client dans la même transaction — plafond = montant encaissé, idempotent (clé unique).',
        needsReason: true,
      });
    }
    if (o.status === 'PROVISIONING') {
      list.push({
        key: 'force-provision',
        label: 'Relancer le provisioning (forcé)',
        hint: 'Rejoue les actions même si un provisioning est déjà en cours.',
        needsReason: false,
      });
      list.push({
        key: 'cancel-provisioning',
        label: 'Annuler le provisioning',
        hint: 'Rollback idempotent d’un provisioning incomplet (facture PAID jamais modifiée).',
        needsReason: true,
      });
      list.push({
        key: 'finalize',
        label: 'Finaliser (C4)',
        hint: 'Reprise d’une fenêtre C4 (preuve provider relue côté serveur).',
        needsReason: true,
      });
    }
    if (o.status === 'ACTIVE') {
      list.push({
        key: 'terminate',
        label: 'Terminer le service',
        hint: 'Arrêt idempotent du service actif (facture et projet conservés).',
        needsReason: true,
      });
      if (o.subscription) {
        list.push({
          key: 'resync-limits',
          label: 'Ré-synchroniser les limites',
          hint: 'Ré-applique les limites du pack courant aux apps déployées (upgrades).',
          needsReason: false,
        });
      }
    }
    return list;
  };

  const runAction = async (a: OrderActionDef) => {
    if (!detail) return;
    const reason = actionReason.trim();
    if (a.needsReason && reason.length < 8) {
      toast.error('Le motif doit faire au moins 8 caractères.');
      return;
    }
    // GO Q9 — validation du remboursement AVANT toute écriture.
    let refundCents = 0;
    if (a.key === 'refund') {
      refundCents = Math.round(
        Number.parseFloat(refundAmount.replace(',', '.')) * 100,
      );
      if (!Number.isFinite(refundCents) || refundCents <= 0) {
        toast.error('Montant de remboursement invalide.');
        return;
      }
      if (refundCents > detail.amountTtcCents) {
        toast.error(
          `Le montant dépasse le total encaissé (${formatCents(detail.amountTtcCents)}).`,
        );
        return;
      }
    }
    setActionBusy(true);
    let res: ApiResult;
    switch (a.key) {
      case 'provision':
        res = await adminProvisionOrder(token, detail.id);
        break;
      case 'force-provision':
        res = await adminProvisionOrder(token, detail.id, true);
        break;
      case 'cancel-provisioning':
        res = await adminCancelProvisioning(token, detail.id, reason);
        break;
      case 'terminate':
        res = await adminTerminateOrder(token, detail.id, reason);
        break;
      case 'finalize':
        res = await adminFinalizeOrder(token, detail.id, reason);
        break;
      case 'resync-limits':
        res = await adminResyncLimits(token, detail.id);
        break;
      case 'refund':
        res = await createAdminRefund(
          token,
          detail.id,
          {
            amountCents: refundCents,
            reason,
            issueCreditNote: refundCreditNote,
          },
          // clé unique par action : un double-clic = rejeu idempotent, jamais
          // un double crédit.
          `mgr-${crypto.randomUUID()}`,
        );
        break;
      default:
        res = { ok: false, status: 0, data: null };
    }
    setActionBusy(false);
    if (!res.ok) {
      toast.error(apiError(res, `L’action « ${a.label} » a échoué.`));
      return;
    }
    if (a.key === 'refund') {
      const rf = res.data as { status?: string; replayed?: boolean } | null;
      if (rf?.replayed) {
        toast.info('Remboursement déjà enregistré (rejeu idempotent, aucun double crédit).');
      } else if (rf?.status === 'SUCCEEDED') {
        toast.ok(
          `Remboursement exécuté — ${formatCents(refundCents)} crédités au portefeuille${refundCreditNote ? ' + avoir émis' : ''}.`,
        );
      } else {
        toast.ok('Remboursement enregistré (en attente de traitement).');
      }
    } else {
      toast.ok(`« ${a.label} » exécutée.`);
    }
    setPendingAction(null);
    setActionReason('');
    setRefundAmount('');
    setRefundCreditNote(false);
    await load(token, page, status, q);
    await openDetail(detail.id);
  };

  const pickAction = (a: OrderActionDef) => {
    if (a.needsReason) {
      setPendingAction(a);
      setActionReason('');
      if (a.key === 'refund') {
        setRefundAmount('');
        setRefundCreditNote(false);
      }
      return;
    }
    void runAction(a);
  };

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

            {actionsFor(detail).length > 0 && (
              <Panel title="Actions administrateur">
                <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  {actionsFor(detail).map((a) => (
                    <Button
                      key={a.key}
                      size="sm"
                      variant="secondary"
                      disabled={actionBusy || pendingAction !== null}
                      onClick={() => pickAction(a)}
                    >
                      {a.label}
                    </Button>
                  ))}
                </div>
                <p className="muted cell-sub" style={{ marginTop: 8 }}>
                  {pendingAction
                    ? pendingAction.hint
                    : 'Chaque action est tracée (acteur + motif) dans le journal d’audit — serveur faisant foi des gardes d’état.'}
                </p>
                {pendingAction && (
                  <div className="mt">
                    {pendingAction.key === 'refund' && (
                      <>
                        <Field label="Montant à rembourser (devise)">
                          <Input
                            value={refundAmount}
                            placeholder="ex. 10.50"
                            inputMode="decimal"
                            onChange={(e) => setRefundAmount(e.target.value)}
                          />
                        </Field>
                        <label className="row cell-sub" style={{ gap: 6, marginBottom: 8, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={refundCreditNote}
                            onChange={(e) => setRefundCreditNote(e.target.checked)}
                          />
                          Émettre un avoir (facture de crédit liée à la facture d’origine)
                        </label>
                      </>
                    )}
                    <Field label={`Motif — ${pendingAction.label}`}>
                      <Input
                        value={actionReason}
                        maxLength={500}
                        placeholder="Au moins 8 caractères (audit + historique)"
                        onChange={(e) => setActionReason(e.target.value)}
                      />
                    </Field>
                    <div className="row">
                      <Button
                        size="sm"
                        disabled={
                          actionBusy ||
                          actionReason.trim().length < 8 ||
                          (pendingAction.key === 'refund' &&
                            !(/^\d+([.,]\d{1,2})?$/.test(refundAmount.replace(',', '.')) &&
                              Number.parseFloat(refundAmount.replace(',', '.')) > 0))
                        }
                        onClick={() => void runAction(pendingAction)}
                      >
                        {actionBusy ? 'Exécution…' : 'Valider'}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={actionBusy}
                        onClick={() => {
                          setPendingAction(null);
                          setActionReason('');
                        }}
                      >
                        Annuler
                      </Button>
                    </div>
                  </div>
                )}
              </Panel>
            )}

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
