'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  fetchMe,
  formatCents,
  getMyInvoice,
  getMyOrder,
  getSessionToken,
  listMyOrders,
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TONE,
  payMyOrderWithWallet,
  setMyOrderRenewal,
  type InvoiceDetail,
  type Me,
  type OrderDetail,
  type OrderListPage,
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
 * GO P4 (lot B1) — « Mes commandes » de l'espace client : liste paginée +
 * détail. L'ISOLATION est portée par l'API (filtre propriétaire, 404 au
 * détail) : cette page n'affiche QUE ce que le serveur retourne pour le token
 * courant. `?id=` ouvre le détail (lien depuis la page de confirmation).
 */
export default function ClientOrdersPage() {
  const router = useRouter();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [data, setData] = useState<OrderListPage | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  // Q-A (GO item 1+4) — règlement par solde + armement/révocation renouvellement.
  const [paying, setPaying] = useState(false);
  const [renewing, setRenewing] = useState(false);

  const load = useCallback(
    async (t: string, p: number, st: string) => {
      const r = await listMyOrders(t, {
        page: p,
        perPage: PER_PAGE,
        status: st || undefined,
      });
      if (!r.ok) {
        toast.error('Impossible de charger vos commandes.');
        return;
      }
      setData(r.data);
    },
    [toast],
  );

  const openDetail = useCallback(
    async (t: string, id: string) => {
      setDetail(null);
      setInvoice(null);
      setDetailLoading(true);
      window.history.replaceState(
        null,
        '',
        `/client/commandes?id=${encodeURIComponent(id)}`,
      );
      const r = await getMyOrder(t, id);
      setDetailLoading(false);
      if (!r.ok) {
        if (r.status === 404) toast.error('Cette commande ne vous appartient pas ou n’existe plus.');
        else toast.error('Impossible de charger la commande.');
        window.history.replaceState(null, '', '/client/commandes');
        return;
      }
      setDetail(r.data);
    },
    [toast],
  );

  const closeDetail = useCallback(() => {
    setDetail(null);
    setInvoice(null);
    window.history.replaceState(null, '', '/client/commandes');
  }, []);

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
    setPage(1);
    void load(token, 1, v);
  };

  /**
   * Q-A (item 1) — règlement par SOLDE : le serveur exécute débit + encaissement
   * en UNE transaction (jamais de double débit). Échec (solde insuffisant,
   * commande déjà réglée…) = message serveur, aucun état local modifié.
   */
  const payByWallet = useCallback(async () => {
    if (!detail) return;
    setPaying(true);
    const r = await payMyOrderWithWallet(token, detail.id);
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
        ? 'Commande déjà réglée — aucun nouveau débit.'
        : 'Commande réglée par solde.',
    );
    await openDetail(token, detail.id);
    await load(token, page, status);
  }, [detail, token, toast, openDetail, load, page, status]);

  /**
   * Q-A (item 4) — armement (consentement daté) / RÉVOCATION immédiate du
   * renouvellement automatique, CAS côté serveur.
   */
  const toggleRenewal = useCallback(
    async (enabled: boolean) => {
      if (!detail) return;
      setRenewing(true);
      const r = await setMyOrderRenewal(token, detail.id, enabled);
      setRenewing(false);
      if (!r.ok) {
        const msg = (r.data as { message?: string } | null)?.message;
        toast.error(msg && typeof msg === 'string' ? msg : 'Modification impossible.');
        return;
      }
      toast.ok(
        enabled
          ? 'Renouvellement automatique activé.'
          : 'Renouvellement automatique révoqué.',
      );
      const fresh = r.data;
      if (!fresh) return;
      setDetail((d) =>
        d
          ? {
              ...d,
              autoRenew: fresh.autoRenew,
              renewalConsentAt: fresh.renewalConsentAt,
              nextBillingDate: fresh.nextBillingDate,
            }
          : d,
      );
      await load(token, page, status);
    },
    [detail, token, toast, load, page, status],
  );

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  if (phase === 'loading') {
    return (
      <AppShell me={null} nav={CLIENT_NAV} activeHref="/client/commandes">
        <PageLoading />
      </AppShell>
    );
  }

  if (phase === 'denied') {
    return (
      <AppShell me={null} nav={CLIENT_NAV} tenant={{ label: 'Espace client' }} activeHref="/client/commandes">
        <div className="auth-wrap">
          <div className="auth-card">
            <h2>Connexion requise</h2>
            <p>Connectez-vous pour consulter vos commandes.</p>
            <a className="btn-primary" href="/auth">Se connecter</a>
          </div>
        </div>
      </AppShell>
    );
  }

  const showDetail = detailLoading || detail !== null;

  return (
    <AppShell me={me} nav={CLIENT_NAV} tenant={{ label: 'Espace client' }} activeHref="/client/commandes">
      <div className="wrap-md">
        {!showDetail && (
          <>
            <PageIntro
              eyebrow="Espace client"
              title="Mes commandes"
              sub="L’historique complet de vos achats sur la plateforme — état réel confirmé par le serveur."
            />

            <div className="row mb">
              <Field label="Statut">
                <Select value={status} onChange={(e) => changeStatus(e.target.value)} className="select-sm">
                  <option value="">Tous</option>
                  {Object.entries(ORDER_STATUS_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              {data && (
                <span className="muted cell-sub" style={{ paddingBottom: 10 }}>
                  {data.total} commande(s)
                </span>
              )}
            </div>

            {!data || data.items.length === 0 ? (
              <EmptyState title="Aucune commande">
                Vous n’avez pas encore de commande. Découvrez les produits dans la boutique.
                <div style={{ marginTop: 12 }}>
                  <a className="btn-primary" href="/shop">Aller à la boutique</a>
                </div>
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                  <th>Référence</th>
                  <th>Produit</th>
                  <th>Montant TTC</th>
                  <th>Abonnement</th>
                  <th>Statut</th>
                  <th>Date</th>
                  <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.items ?? []).map((o) => (
                      <tr key={o.id}>
                        <td className="muted nowrap" title={o.id}>{o.id.slice(0, 10)}…</td>
                        <td>{o.productName}</td>
                        <td className="nowrap">
                          {formatCents(o.amountTtcCents)}{' '}
                          <span className="muted">{o.currency}</span>
                        </td>
                        <td className="nowrap">
                          {o.billingCycle === 'ONETIME' ? (
                            <span className="muted">—</span>
                          ) : o.autoRenew && o.nextBillingDate ? (
                            <Badge tone="info">
                              Auto · {new Date(o.nextBillingDate).toLocaleDateString()}
                            </Badge>
                          ) : (
                            <Badge tone="neutral">Renouvellement arrêté</Badge>
                          )}
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
                          <Button size="sm" variant="secondary" onClick={() => void openDetail(token, o.id)}>
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
                    void load(token, p, status);
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
                    void load(token, p, status);
                  }}
                >
                  Suivant →
                </Button>
              </div>
            )}
          </>
        )}

        {showDetail && detailLoading && (
          <PageLoading label="Chargement de la commande." />
        )}

        {showDetail && !detailLoading && detail && (
          <>
            <button className="store-back" type="button" onClick={closeDetail}>
              ← Retour à la liste
            </button>

            <PageIntro
              eyebrow="Espace client"
              title={detail.productName}
              sub={`Commande ${detail.id}`}
            />

            <Panel title="État de la commande">
              <div className="row mb">
                <Badge tone={ORDER_STATUS_TONE[detail.status] ?? 'neutral'}>
                  {ORDER_STATUS_LABEL[detail.status] ?? detail.status}
                </Badge>
                <span className="muted cell-sub">
                  Créée le {new Date(detail.createdAt).toLocaleString()}
                  {detail.paidAt ? ` — payée le ${new Date(detail.paidAt).toLocaleString()}` : ''}
                </span>
              </div>

              {/* Q-A (item 1) — réglage direct par solde sur commande en attente. */}
              {detail.status === 'PENDING_PAYMENT' && (
                <div className="row mb" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <Button size="sm" disabled={paying} onClick={() => void payByWallet()}>
                    {paying ? 'Règlement…' : 'Régler par solde'}
                  </Button>
                  <span className="muted cell-sub">
                    Débit et confirmation sont exécutés en une seule opération sur votre
                    portefeuille.
                  </span>
                </div>
              )}
              {(detail.statusHistory ?? []).length > 0 && (
                <ol className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
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

            <Panel title="Détail">
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
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Cycle de facturation</span>
                  <span>{detail.billingCycle}</span>
                </li>
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Renouvellement automatique</span>
                  <span>
                    {detail.billingCycle === 'ONETIME' ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        {detail.autoRenew ? (
                          <Badge tone="info">Activé</Badge>
                        ) : (
                          <Badge tone="neutral">Arrêté</Badge>
                        )}
                        {/* Q-A (item 4) — armement possible seulement après
                            règlement ; révocation à tout moment (CAS serveur). */}
                        {detail.billingCycle !== 'ONETIME' &&
                          detail.status !== 'PENDING_PAYMENT' &&
                          detail.status !== 'CANCELLED' &&
                          detail.status !== 'REFUNDED' && (
                            <Button
                              size="sm"
                              variant={detail.autoRenew ? 'secondary' : 'primary'}
                              disabled={renewing}
                              onClick={() => void toggleRenewal(!detail.autoRenew)}
                            >
                              {renewing
                                ? '…'
                                : detail.autoRenew
                                  ? 'Révoquer'
                                  : 'Activer'}
                            </Button>
                          )}
                      </span>
                    )}
                  </span>
                </li>
                {detail.renewalConsentAt && (
                  <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                    <span className="muted">Consentement renouvellement</span>
                    <span className="nowrap">
                      accordé le {new Date(detail.renewalConsentAt).toLocaleDateString('fr-FR')}
                    </span>
                  </li>
                )}
                {detail.autoRenew && detail.nextBillingDate && (
                  <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                    <span className="muted">Prochaine échéance</span>
                    <span className="nowrap">
                      {new Date(detail.nextBillingDate).toLocaleDateString('fr-FR')}
                    </span>
                  </li>
                )}
                {detail.renewsOrderId && (
                  <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                    <span className="muted">Renouvellement de la commande</span>
                    <span className="muted nowrap" title={detail.renewsOrderId}>
                      {detail.renewsOrderId.slice(0, 10)}…
                    </span>
                  </li>
                )}
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Moyen de paiement</span>
                  <span>{detail.paymentMethodName ?? '—'}</span>
                </li>
                <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                  <span className="muted">Adresse de livraison</span>
                  <span>{detail.customerEmail}</span>
                </li>
                {detail.requestedSubdomain && (
                  <li className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                    <span className="muted">Sous-domaine choisi</span>
                    <span>{detail.requestedSubdomain}</span>
                  </li>
                )}
              </ul>
            </Panel>

            <Panel title="Facture">
              {detail.invoice ? (
                <div className="row">
                  <span>
                    Facture <b>{detail.invoice.number}</b>{' '}
                    <Badge tone={detail.invoice.status === 'PAID' ? 'green' : 'amber'}>
                      {detail.invoice.status}
                    </Badge>
                  </span>
                  {!invoice && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        void (async () => {
                          const r = await getMyInvoice(token, detail.invoice!.id);
                          if (!r.ok) {
                            toast.error('Impossible de charger la facture.');
                            return;
                          }
                          setInvoice(r.data);
                        })();
                      }}
                    >
                      Voir la facture
                    </Button>
                  )}
                </div>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  Aucune facture émise pour cette commande.
                </p>
              )}

              {invoice && (
                <div className="table-wrap" style={{ marginTop: 12 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Ligne</th>
                        <th>Qté</th>
                        <th>PU HT</th>
                        <th>Total TTC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(invoice.lines ?? []).map((l) => (
                        <tr key={l.id}>
                          <td>{l.label}</td>
                          <td>{l.qty}</td>
                          <td>{formatCents(l.unitPriceHtCents)}</td>
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
