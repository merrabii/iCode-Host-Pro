'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  downloadInvoicePdf,
  formatCents,
  getAdminInvoice,
  listAdminInvoices,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  type AdminInvoiceListItem,
  type InvoiceDetail,
  type InvoiceListPage,
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

const PER_PAGE = 20;

/**
 * GO P4 (lot B1) — Factures (ADMIN) : liste globale paginée (recherche numéro
 * / email client, filtre statut) + détail (lignes, adresse, commande liée).
 */
export default function ManagerInvoicesPage() {
  const { phase: sessionPhase, me, token } = useAdminSession();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<InvoiceListPage<AdminInvoiceListItem> | null>(null);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(
    async (t: string, p: number, st: string, search: string) => {
      const r = await listAdminInvoices(t, {
        page: p,
        perPage: PER_PAGE,
        status: st || undefined,
        q: search || undefined,
      });
      if (!r.ok) {
        toast.error('Impossible de charger les factures.');
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
      window.history.replaceState(null, '', `/manager/factures?id=${encodeURIComponent(id)}`);
      const r = await getAdminInvoice(token, id);
      setDetailLoading(false);
      if (!r.ok) {
        toast.error('Facture introuvable.');
        window.history.replaceState(null, '', '/manager/factures');
        return;
      }
      setDetail(r.data);
    },
    [token, toast],
  );

  const closeDetail = useCallback(() => {
    setDetail(null);
    window.history.replaceState(null, '', '/manager/factures');
  }, []);

  // GO P7 (D1) : PDF figé à l'émission, généré à la première demande.
  const downloadPdf = useCallback(
    async (inv: { id: string; number: string }) => {
      const r = await downloadInvoicePdf(token, 'admin', inv);
      if (!r.ok) toast.error('Téléchargement du PDF impossible.');
    },
    [token, toast],
  );

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

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

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
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }} activeHref="/manager/factures">
      <div className="wrap-md">
        {!showDetail && (
          <>
            <PageIntro
              eyebrow="Administration"
              title="Factures"
              sub="Toutes les factures émises sur la plateforme — recherche par numéro ou client, détail des lignes."
            />

            <div className="row mb">
              <Field label="Statut">
                <Select value={status} onChange={(e) => changeStatus(e.target.value)} className="select-sm">
                  <option value="">Tous</option>
                  {Object.entries(INVOICE_STATUS_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Recherche">
                <Input
                  value={q}
                  placeholder="numéro ou email client"
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
                  {data.total} facture(s)
                </span>
              )}
            </div>

            {!data || data.items.length === 0 ? (
              <EmptyState>Aucune facture.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Numéro</th>
                      <th>Client</th>
                      <th>Commande</th>
                      <th>Montant TTC</th>
                      <th>Statut</th>
                      <th>Émise le</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.items ?? []).map((inv) => (
                      <tr key={inv.id}>
                        <td className="nowrap"><b>{inv.number}</b></td>
                        <td className="nowrap">{inv.customer?.email ?? '—'}</td>
                        <td className="muted">{inv.order ? inv.order.productName : '—'}</td>
                        <td className="nowrap">
                          {formatCents(inv.amountTtcCents)}{' '}
                          <span className="muted">{inv.currency}</span>
                        </td>
                        <td>
                          <Badge tone={INVOICE_STATUS_TONE[inv.status] ?? 'neutral'}>
                            {INVOICE_STATUS_LABEL[inv.status] ?? inv.status}
                          </Badge>
                        </td>
                        <td className="muted nowrap">
                          {new Date(inv.issuedAt).toLocaleDateString()}
                          {inv.dueDate && (
                            <>
                              <br />
                              <span className="cell-sub">
                                Éché. {new Date(inv.dueDate).toLocaleDateString()}
                              </span>
                            </>
                          )}
                        </td>
                        <td className="nowrap" style={{ textAlign: 'right' }}>
                          <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                            <Button size="sm" variant="secondary" onClick={() => void openDetail(inv.id)}>
                              Détail
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => void downloadPdf(inv)}>
                              PDF
                            </Button>
                          </span>
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

        {showDetail && detailLoading && <PageLoading label="Chargement de la facture." />}

        {showDetail && !detailLoading && detail && (
          <>
            <button className="store-back" type="button" onClick={closeDetail}>
              ← Retour à la liste
            </button>

            <PageIntro
              eyebrow="Administration"
              title={`Facture ${detail.number}`}
              sub={`Client ${detail.customer?.email ?? '—'} — émise le ${new Date(detail.issuedAt).toLocaleDateString()}`}
            />

            <Panel title="Récapitulatif">
              <div className="row mb">
                <Badge tone={INVOICE_STATUS_TONE[detail.status] ?? 'neutral'}>
                  {INVOICE_STATUS_LABEL[detail.status] ?? detail.status}
                </Badge>
                <Button size="sm" variant="secondary" onClick={() => void downloadPdf(detail)}>
                  Télécharger le PDF
                </Button>
                {detail.hasPdf && <span className="muted cell-sub">PDF déjà généré</span>}
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 14 }}>
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Montant HT</span>
                  <span>{formatCents(detail.amountHtCents)}</span>
                </li>
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Taxe</span>
                  <span>{formatCents(detail.taxAmountCents)}</span>
                </li>
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Total TTC</span>
                  <strong>{formatCents(detail.amountTtcCents)} {detail.currency}</strong>
                </li>
                {detail.order && (
                  <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                    <span className="muted">Commande</span>
                    <span>{detail.order.productName}</span>
                  </li>
                )}
                {detail.dueDate && (
                  <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                    <span className="muted">Échéance</span>
                    <span>{new Date(detail.dueDate).toLocaleDateString()}</span>
                  </li>
                )}
                {detail.paidAt && (
                  <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                    <span className="muted">Réglée le</span>
                    <span>{new Date(detail.paidAt).toLocaleString()}</span>
                  </li>
                )}
              </ul>
            </Panel>

            <Panel title="Lignes de facture">
              {(detail.lines ?? []).length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>Aucune ligne.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Ligne</th>
                        <th>Qté</th>
                        <th>PU HT</th>
                        <th>Taxe</th>
                        <th>Total TTC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detail.lines ?? []).map((l) => (
                        <tr key={l.id}>
                          <td>{l.label}</td>
                          <td>{l.qty}</td>
                          <td>{formatCents(l.unitPriceHtCents)}</td>
                          <td>{formatCents(l.taxAmountCents)}</td>
                          <td>{formatCents(l.totalTtcCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </>
        )}
      </div>
    </AppShell>
  );
}
