'use client';

import { useEffect, useState } from 'react';
import {
  adminListSubscriptions,
  adminSyncSubscriptionLimits,
  adminUpdateSubscription,
  apiError,
  formatCents,
  Subscription,
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
  PageIntro,
  PageLoading,
  Panel,
  statusTone,
} from '@/components/ui';
import { IconBox, IconRefresh } from '@/components/icons';

const SUB_STATUS_LABEL: Record<string, string> = {
  PENDING: 'En attente',
  ACTIVE: 'Active',
  REJECTED: 'Rejetée',
  SUSPENDED: 'Suspendue',
  CANCELLED: 'Annulée',
};
const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'En attente de paiement',
  PAID: 'Payée',
  PROVISIONING: 'En provisionnement',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspendue',
  CANCELLED: 'Annulée',
  REFUNDED: 'Remboursée',
};
const DEP_STATUS_LABEL: Record<string, string> = {
  PENDING: 'En file',
  DEPLOYING: 'En cours',
  ACTIVE: 'Déployé',
  FAILED: 'Échec',
};

export default function ManagerSubscriptionsPage() {
  const { phase, me, token } = useAdminSession();
  const toast = useToast();
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [resyncId, setResyncId] = useState<string | null>(null);

  async function load(t: string) {
    const sr = await adminListSubscriptions(t);
    if (!sr.ok) {
      toast.error('Impossible de charger les abonnements.');
      return;
    }
    setSubs((sr.data as Subscription[]) ?? []);
  }

  useEffect(() => {
    if (phase === 'ready' && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  async function changeSub(id: string, status: string) {
    const r = await adminUpdateSubscription(token, id, status);
    if (!r.ok) return toast.error(apiError(r, 'Transition refusée.'));
    toast.ok(`Souscription → ${SUB_STATUS_LABEL[status] ?? status}`);
    void load(token);
  }

  async function resync(id: string) {
    setResyncId(id);
    const r = await adminSyncSubscriptionLimits(token, id);
    setResyncId(null);
    if (!r.ok) return toast.error(apiError(r, 'Ré-synchronisation impossible.'));
    const d = r.data as { checked: number; applied: number; failed: number } | null;
    toast.ok(
      d
        ? `Ressources synchronisées : ${d.applied}/${d.checked} app(s) mises aux limites du pack${d.failed ? ` (${d.failed} en échec)` : ''}.`
        : 'Ressources synchronisées.',
    );
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
          title="Abonnements"
          sub="Chaque commande store payée crée ou met à niveau l’abonnement ACTIVE du client. L’admin suspend, réactive ou ré-synchronise les ressources des apps déployées."
        />

        <Panel
          title="Abonnements client"
          sub="Client · pack · produit · commande liée · apps déployées · actions."
        >
          {subs.length === 0 ? (
            <EmptyState>Aucun abonnement pour l’instant — les premières commandes store les créeront.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Produit</th>
                    <th>Pack</th>
                    <th>Commande</th>
                    <th>Statut</th>
                    <th className="ta-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {subs.map((s) => {
                    const pack = s.product?.pack ?? null;
                    const apps = s.user?.deployments ?? [];
                    const order = s.order ?? null;
                    return (
                      <tr key={s.id}>
                        <td className="cell-title">
                          {s.user?.name ?? s.user?.email ?? '?'}
                          <div className="muted cell-sub">
                            {s.user?.email}
                            {apps.length ? ` · ${apps.length} app(s)` : ''}
                          </div>
                        </td>
                        <td className="cell-title">
                          {s.product?.name ?? s.productId}
                          <div className="muted cell-sub">{s.product?.kind ?? ''}</div>
                        </td>
                        <td className="cell-title">
                          {pack ? (
                            <>
                              {pack.name}
                              <div className="muted cell-sub">
                                {pack.ramMb} Mo · {pack.cpuCores} CPU
                                {pack.maxApps ? ` · ${pack.maxApps} apps` : ' · apps ∞'}
                              </div>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="cell-title">
                          {order ? (
                            <>
                              <span className="muted">{order.productName ?? 'Commande'}</span>
                              <div className="muted cell-sub">
                                {formatCents(order.amountTtcCents)} {order.currency}{' '}
                                · {ORDER_STATUS_LABEL[order.status ?? '' ] ?? order.status ?? ''}
                                {order.createdAt
                                  ? ' · ' + new Date(order.createdAt).toLocaleDateString()
                                  : ''}
                              </div>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <Badge tone={statusTone(s.status)}>
                            {SUB_STATUS_LABEL[s.status] ?? s.status}
                          </Badge>
                          {apps.length > 0 && (
                            <div className="mt-sm muted" style={{ fontSize: 12 }}>
                              <IconBox />
                              {apps.slice(0, 2).map((a) => (
                                <div key={a.id} className="muted cell-sub">
                                  {a.appName ?? a.repoFullName}
                                  {a.fqdn ? ` · ${a.fqdn}` : ''} ·{' '}
                                  {DEP_STATUS_LABEL[a.status ?? ''] ?? a.status}
                                </div>
                              ))}
                              {apps.length > 2 && (
                                <div className="muted cell-sub">+{apps.length - 2} autre(s)</div>
                              )}
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="row ta-right">
                            {s.status === 'PENDING' && (
                              <>
                                <Button size="sm" onClick={() => changeSub(s.id, 'ACTIVE')}>Approuver</Button>
                                <Button size="sm" variant="secondary" onClick={() => changeSub(s.id, 'REJECTED')}>Rejeter</Button>
                              </>
                            )}
                            {s.status === 'ACTIVE' && (
                              <Button size="sm" variant="danger" onClick={() => changeSub(s.id, 'SUSPENDED')}>Suspendre</Button>
                            )}
                            {s.status === 'SUSPENDED' && (
                              <Button size="sm" onClick={() => changeSub(s.id, 'ACTIVE')}>Réactiver</Button>
                            )}
                            {s.status === 'ACTIVE' && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={resyncId === s.id}
                                onClick={() => resync(s.id)}
                                title="Ré-applique les limites RAM/CPU du pack sur les apps déjà déployées"
                              >
                                <IconRefresh />
                                {resyncId === s.id ? 'Sync…' : 'Ré-synchroniser'}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}