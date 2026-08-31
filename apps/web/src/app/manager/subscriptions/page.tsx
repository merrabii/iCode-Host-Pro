'use client';

import { useEffect, useState } from 'react';
import {
  adminListServices,
  adminListSubscriptions,
  adminUpdateService,
  adminUpdateSubscription,
  apiError,
  Service,
  Subscription,
} from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import {
  Alert,
  Badge,
  Button,
  Denied,
  EmptyState,
  PageIntro,
  PageLoading,
  Panel,
  Select,
  statusTone,
} from '@/components/ui';
import { IconServer } from '@/components/icons';

const SUB_STATUS_LABEL: Record<string, string> = {
  PENDING: 'En attente',
  ACTIVE: 'Active',
  REJECTED: 'Rejetée',
  SUSPENDED: 'Suspendue',
  CANCELLED: 'Annulée',
};
const SERVICE_STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'Demandé',
  PROVISIONING: 'En provisionnement',
  ACTIVE: 'Actif',
  PROBLEM: 'Problème',
  SUSPENDED: 'Suspendu',
  REMOVED: 'Retiré',
};

interface ServerItem {
  id: string;
  name: string;
  hostname: string;
  status: string;
}

export default function ManagerSubscriptionsPage() {
  const { phase, me, token } = useAdminSession();
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [serverChoice, setServerChoice] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(t: string) {
    setError(null);
    const [sr, ss, serversRes] = await Promise.all([
      adminListSubscriptions(t),
      adminListServices(t),
      fetch('/api/servers', { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()),
    ]);
    if (!sr.ok || !ss.ok) {
      setError('Impossible de charger les souscriptions / services.');
      return;
    }
    setSubs((sr.data as Subscription[]) ?? []);
    setServices((ss.data as Service[]) ?? []);
    const list = serversRes as ServerItem[];
    setServers(list);
    // Pre-select a server per service when none is assigned yet.
    const choice: Record<string, string> = {};
    for (const svc of ss.data as Service[]) {
      choice[svc.id] = svc.server?.id ?? (list[0]?.id ?? '');
    }
    setServerChoice(choice);
  }

  useEffect(() => {
    if (phase === 'ready' && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  function flash(m: string) {
    setMessage(m);
    setError(null);
  }

  async function changeSub(id: string, status: string) {
    const r = await adminUpdateSubscription(token, id, status);
    if (!r.ok) return setError(apiError(r, 'Transition refusée.'));
    flash(`Souscription → ${SUB_STATUS_LABEL[status] ?? status}`);
    void load(token);
  }

  async function changeService(id: string, patch: { status?: string; serverId?: string }) {
    const r = await adminUpdateService(token, id, patch);
    if (!r.ok) return setError(apiError(r, 'Transition refusée.'));
    flash('Service mis à jour.');
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
          title="Souscriptions & services"
          sub="Le client garde le contrôle de ses souscriptions/services ; l’admin approuve et affecte une infrastructure (serveur)."
        />

        {message && <Alert tone="ok">{message}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}

        <Panel title="Souscriptions client" sub="Approbation / rejet / suspension par transaction d’état.">
          {subs.length === 0 ? (
            <EmptyState>Aucune souscription pour l’instant.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Offre</th>
                    <th>Client</th>
                    <th>Statut</th>
                    <th className="ta-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {subs.map((s) => (
                    <tr key={s.id}>
                      <td className="cell-title">{s.product?.name ?? s.productId}</td>
                      <td className="muted">{s.user?.email ?? '?'}</td>
                      <td>
                        <Badge tone={statusTone(s.status)}>{SUB_STATUS_LABEL[s.status] ?? s.status}</Badge>
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
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="mt">
          <Panel
            title="Services demandés"
            sub="Affecter un serveur existant puis provisionner (stub). Aucune infrastructure n’est exposée au client."
          >
            {services.length === 0 ? (
              <EmptyState>Aucun service pour l’instant.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th>Client</th>
                      <th>Statut</th>
                      <th className="ta-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {services.map((svc) => (
                      <tr key={svc.id}>
                        <td className="cell-title">
                          {svc.name}
                          <div className="muted cell-sub">{svc.subscription?.product?.name ?? ''}</div>
                        </td>
                        <td className="muted">{svc.subscription?.user?.email ?? '?'}</td>
                        <td>
                          <Badge tone={statusTone(svc.status)}>{SERVICE_STATUS_LABEL[svc.status] ?? svc.status}</Badge>
                        </td>
                        <td>
                          {(svc.status === 'REQUESTED' || svc.status === 'PROVISIONING') && (
                            <div className="row ta-right">
                              <Select
                                className="select-sm"
                                value={serverChoice[svc.id] ?? ''}
                                onChange={(e) => setServerChoice({ ...serverChoice, [svc.id]: e.target.value })}
                                aria-label="serveur"
                              >
                                <option value="">—</option>
                                {servers.map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.name} ({s.hostname})
                                  </option>
                                ))}
                              </Select>
                              <Button
                                size="sm"
                                disabled={!serverChoice[svc.id]}
                                onClick={() =>
                                  changeService(svc.id, {
                                    status: svc.status === 'REQUESTED' ? 'PROVISIONING' : 'ACTIVE',
                                    serverId: serverChoice[svc.id],
                                  })
                                }
                              >
                                <IconServer size={14} />
                                {svc.status === 'REQUESTED' ? 'Affecter & provisionner' : 'Activer (stub)'}
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {services.some((s) => s.server?.id) && (
              <p className="muted cell-sub mt-sm">
                Serveurs affectés :{' '}
                {services
                  .filter((s) => s.server?.id)
                  .map((s) => s.server?.name)
                  .join(', ')}
              </p>
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
