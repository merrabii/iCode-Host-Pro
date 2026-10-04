'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  downloadInvoicePdf,
  fetchMe,
  formatCents,
  getMyInvoice,
  getSessionToken,
  listMyInvoices,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  payMyInvoiceWithWallet,
  type InvoiceDetail,
  type InvoiceListPage,
  type Me,
} from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { CLIENT_NAV } from '@/config/nav';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  PageIntro,
  PageLoading,
  Panel,
  Select,
} from '@/components/ui';

type Phase = 'loading' | 'denied' | 'ready';

const PER_PAGE = 20;

/**
 * GO P4 (lot B1) — « Mes factures » de l'espace client : liste paginée +
 * détail (lignes). Isolation portée par l'API (filtre propriétaire, 404 au
 * détail). `?id=` ouvre le détail.
 */
export default function ClientInvoicesPage() {
  const router = useRouter();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('');
  const [data, setData] = useState<InvoiceListPage | null>(null);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Q-A (GO item 1) — règlement d'une facture UNPAID par solde (atomique).
  const [paying, setPaying] = useState(false);

  const load = useCallback(
    async (t: string, p: number, st: string) => {
      const r = await listMyInvoices(t, {
        page: p,
        perPage: PER_PAGE,
        status: st || undefined,
      });
      if (!r.ok) {
        toast.error('Impossible de charger vos factures.');
        return;
      }
      setData(r.data);
    },
    [toast],
  );

  const openDetail = useCallback(
    async (t: string, id: string) => {
      setDetail(null);
      setDetailLoading(true);
      window.history.replaceState(
        null,
        '',
        `/client/factures?id=${encodeURIComponent(id)}`,
      );
      const r = await getMyInvoice(t, id);
      setDetailLoading(false);
      if (!r.ok) {
        if (r.status === 404) toast.error('Cette facture ne vous appartient pas ou n’existe plus.');
        else toast.error('Impossible de charger la facture.');
        window.history.replaceState(null, '', '/client/factures');
        return;
      }
      setDetail(r.data);
    },
    [toast],
  );

  const closeDetail = useCallback(() => {
    setDetail(null);
    window.history.replaceState(null, '', '/client/factures');
  }, []);

  // GO P7 (D1) : PDF figé à l'émission, généré à la première demande.
  const downloadPdf = useCallback(
    async (inv: { id: string; number: string }) => {
      const r = await downloadInvoicePdf(token, 'client', inv);
      if (!r.ok) {
        toast.error(
          r.status === 404
            ? 'Cette facture ne vous appartient pas ou n’existe plus.'
            : 'Téléchargement du PDF impossible.',
        );
      }
    },
    [token, toast],
  );

  /**
   * Q-A (item 1) — règlement par SOLDE : le serveur redirige vers la commande
   * qui porte la facture (débit + encaissement en UNE transaction). Facture
   * sans commande / déjà réglée → 409 serveur, message affiché tel quel.
   */
  const payByWallet = useCallback(
    async (invId: string) => {
      setPaying(true);
      const r = await payMyInvoiceWithWallet(token, invId);
      setPaying(false);
      if (!r.ok) {
        const msg = (r.data as { message?: string } | null)?.message;
        toast.error(
          msg && typeof msg === 'string' ? msg : 'Règlement refusé (solde insuffisant ?).',
        );
        return;
      }
      toast.ok(
        (r.data as { replayed?: boolean } | null)?.replayed
          ? 'Facture déjà réglée — aucun nouveau débit.'
          : 'Facture réglée par solde.',
      );
      await load(token, 1, status);
      if (detail && detail.id === invId) await openDetail(token, invId);
    },
    [token, toast, load, status, detail, openDetail],
  );

  useEffect(() => {
    (async () => {
      const t = await getSessionToken();
      if (!t) {
        router.replace('/auth');
        return;
      }
      const m = await fetchMe(t);
      if (!m) {
        setPhase('denied');
        return;
      }
      setToken(t);
      setMe(m);
      setPhase('ready');
      await load(t, 1, '');
      const id = new URLSearchParams(window.location.search).get('id');
      if (id) await openDetail(t, id);
    })();
  }, [router, load, openDetail]);

  const changeStatus = (v: string) => {
    setStatus(v);
    void load(token, 1, v);
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  if (phase === 'loading') {
    return (
      <AppShell me={null} nav={CLIENT_NAV} activeHref="/client/factures">
        <PageLoading />
      </AppShell>
    );
  }

  if (phase === 'denied') {
    return (
      <AppShell me={null} nav={CLIENT_NAV} tenant={{ label: 'Espace client' }} activeHref="/client/factures">
        <div className="auth-wrap">
          <div className="auth-card">
            <h2>Connexion requise</h2>
            <p>Connectez-vous pour consulter vos factures.</p>
            <a className="btn-primary" href="/auth">Se connecter</a>
          </div>
        </div>
      </AppShell>
    );
  }

  const showDetail = detailLoading || detail !== null;

  return (
    <AppShell me={me} nav={CLIENT_NAV} tenant={{ label: 'Espace client' }} activeHref="/client/factures">
      <div className="wrap-md">
        {!showDetail && (
          <>
            <PageIntro
              eyebrow="Espace client"
              title="Mes factures"
              sub="Toutes les factures émises sur vos commandes — consultation et lignes détaillées."
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
              {data && (
                <span className="muted cell-sub" style={{ paddingBottom: 10 }}>
                  {data.total} facture(s)
                </span>
              )}
            </div>

            {!data || data.items.length === 0 ? (
              <EmptyState title="Aucune facture">
                Aucune facture n’a encore été émise sur votre compte.
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Numéro</th>
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
                        <td className="muted">
                          {inv.order ? inv.order.productName : '—'}
                        </td>
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
                            {/* Q-A (item 1) — encaissement direct par solde. */}
                            {inv.status === 'UNPAID' && (
                              <Button
                                size="sm"
                                disabled={paying}
                                onClick={() => void payByWallet(inv.id)}
                              >
                                Régler
                              </Button>
                            )}
                            <Button size="sm" variant="secondary" onClick={() => void openDetail(token, inv.id)}>
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
                  onClick={() => void load(token, data.page - 1, status)}
                >
                  ← Précédent
                </Button>
                <span className="muted cell-sub">Page {data.page} / {totalPages}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={data.page >= totalPages}
                  onClick={() => void load(token, data.page + 1, status)}
                >
                  Suivant →
                </Button>
              </div>
            )}
          </>
        )}

        {showDetail && detailLoading && (
          <PageLoading label="Chargement de la facture." />
        )}

        {showDetail && !detailLoading && detail && (
          <>
            <button className="store-back" type="button" onClick={closeDetail}>
              ← Retour à la liste
            </button>

            <PageIntro
              eyebrow="Espace client"
              title={`Facture ${detail.number}`}
              sub={`Émise le ${new Date(detail.issuedAt).toLocaleDateString()} — ${detail.customer?.email ?? ''}`}
            />

            <Panel title="Récapitulatif">
              <div className="row mb">
                <Badge tone={INVOICE_STATUS_TONE[detail.status] ?? 'neutral'}>
                  {INVOICE_STATUS_LABEL[detail.status] ?? detail.status}
                </Badge>
                {/* Q-A (item 1) — règlement par solde depuis le détail. */}
                {detail.status === 'UNPAID' && (
                  <Button
                    size="sm"
                    disabled={paying}
                    onClick={() => void payByWallet(detail.id)}
                  >
                    {paying ? 'Règlement…' : 'Régler par solde'}
                  </Button>
                )}
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
