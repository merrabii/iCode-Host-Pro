'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  adminListServices,
  adminListSubscriptions,
  adminUpdateService,
  adminUpdateSubscription,
  apiError,
  fetchMe,
  getAccessToken,
  Me,
  Service,
  Subscription,
} from '../../../lib/api';

type Phase = 'loading' | 'denied' | 'ready';

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
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
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
    (async () => {
      const t = await getAccessToken();
      if (!t) {
        router.replace('/auth');
        return;
      }
      const m = await fetchMe(t);
      if (!m || m.role !== 'ADMIN') {
        setPhase('denied');
        return;
      }
      setToken(t);
      setMe(m);
      setPhase('ready');
      void load(t);
    })();
  }, [router]);

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

  if (phase !== 'ready') {
    const denied = phase === 'denied';
    return (
      <main style={{ maxWidth: 820, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Souscriptions &amp; services (Phase 5)</h1>
        {denied ? (
          <p style={{ color: 'var(--danger)' }}>Accès refusé : réservé aux administrateurs.</p>
        ) : (
          <p className="muted">Connexion…</p>
        )}
        <p>
          <Link href={denied ? '/auth' : '/manager'}>← Retour</Link>
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 820, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Souscriptions &amp; services (Phase 5)</h1>
      <p className="muted">
        ADR-021 — le client garde le contrôle de ses souscriptions/services ; l&apos;admin approuve
        et affecte une infrastructure (serveur). {me?.email} ·{' '}
        <Link href="/manager">← Retour au manager</Link>
      </p>

      {message && <p style={{ color: 'var(--ok, #1a7f37)' }}>{message}</p>}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <section>
        <h2>Souscriptions client</h2>
        {subs.length === 0 ? (
          <p className="muted">Aucune souscription pour l&apos;instant.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {subs.map((s) => (
              <li
                key={s.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 0',
                  borderBottom: '1px solid var(--border, #e2e2e2)',
                  flexWrap: 'wrap',
                }}
              >
                <span>
                  <strong>{s.product?.name ?? s.productId}</strong>{' '}
                  <span className="muted">par {s.user?.email ?? '?'}</span>
                </span>
                <span className="muted">[{SUB_STATUS_LABEL[s.status] ?? s.status}]</span>
                {s.status === 'PENDING' && (
                  <>
                    <button type="button" onClick={() => changeSub(s.id, 'ACTIVE')}>Approuver</button>
                    <button type="button" onClick={() => changeSub(s.id, 'REJECTED')}>Rejeter</button>
                  </>
                )}
                {s.status === 'ACTIVE' && (
                  <button type="button" onClick={() => changeSub(s.id, 'SUSPENDED')}>Suspendre</button>
                )}
                {s.status === 'SUSPENDED' && (
                  <button type="button" onClick={() => changeSub(s.id, 'ACTIVE')}>Réactiver</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Services demandés</h2>
        {services.length === 0 ? (
          <p className="muted">Aucun service pour l&apos;instant.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {services.map((svc) => (
              <li
                key={svc.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 0',
                  borderBottom: '1px solid var(--border, #e2e2e2)',
                  flexWrap: 'wrap',
                }}
              >
                <span>
                  <strong>{svc.name}</strong>{' '}
                  <span className="muted">
                    · {svc.subscription?.user?.email ?? '?'} · {svc.subscription?.product?.name ?? ''}
                  </span>
                </span>
                <span className="muted">[{SERVICE_STATUS_LABEL[svc.status] ?? svc.status}]</span>
                {(svc.status === 'REQUESTED' || svc.status === 'PROVISIONING') && (
                  <>
                    <label className="muted">
                      Serveur
                      <select
                        value={serverChoice[svc.id] ?? ''}
                        onChange={(e) =>
                          setServerChoice({ ...serverChoice, [svc.id]: e.target.value })
                        }
                        style={{ padding: '4px 6px' }}
                      >
                        <option value="">—</option>
                        {servers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} ({s.hostname})
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={!serverChoice[svc.id]}
                      onClick={() =>
                        changeService(svc.id, {
                          status: svc.status === 'REQUESTED' ? 'PROVISIONING' : 'ACTIVE',
                          serverId: serverChoice[svc.id],
                        })
                      }
                    >
                      {svc.status === 'REQUESTED' ? 'Affecter & provisionner' : 'Activer (stub)'}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {services.some((s) => s.server?.id) && (
          <p className="muted">
            Serveurs affectés : {services.filter((s) => s.server?.id).map((s) => s.server?.name).join(', ')}
          </p>
        )}
      </section>
    </main>
  );
}
