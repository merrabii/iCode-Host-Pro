'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  apiError,
  cancelMySubscription,
  createMyService,
  createMySubscription,
  fetchMe,
  getAccessToken,
  listMyServices,
  listMySubscriptions,
  Me,
  Service,
  Subscription,
} from '../../lib/api';

type Phase = 'loading' | 'denied' | 'ready';

interface Product {
  id: string;
  name: string;
  kind: string;
  status: string;
}

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

export default function ClientPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [serviceName, setServiceName] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(t: string) {
    setError(null);
    try {
      const [p, s, svc] = await Promise.all([
        fetch('/api/products', { headers: { Authorization: `Bearer ${t}` } }).then((r) =>
          r.json(),
        ),
        listMySubscriptions(t),
        listMyServices(t),
      ]);
      setProducts((p as Product[]) ?? []);
      setSubs((s.data as Subscription[]) ?? []);
      setServices((svc.data as Service[]) ?? []);
    } catch {
      setError('Impossible de charger l’espace client.');
    }
  }

  useEffect(() => {
    (async () => {
      const t = await getAccessToken();
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
      void load(t);
    })();
  }, [router]);

  function flash(m: string) {
    setMessage(m);
    setError(null);
  }

  async function subscribe(productId: string) {
    const r = await createMySubscription(token, productId);
    if (!r.ok) return setError(apiError(r, 'Impossible de souscrire.'));
    flash('Souscription envoyée — en attente d’approbation par l’admin.');
    void load(token);
  }

  async function cancelSub(id: string) {
    const r = await cancelMySubscription(token, id);
    if (!r.ok) return setError(apiError(r, 'Impossible d’annuler.'));
    flash('Souscription annulée.');
    void load(token);
  }

  async function requestService(subId: string) {
    const name = (serviceName[subId] ?? '').trim();
    if (!name) return;
    const r = await createMyService(token, subId, name);
    if (!r.ok) return setError(apiError(r, 'Impossible de demander un service.'));
    setServiceName({ ...serviceName, [subId]: '' });
    flash('Service demandé.');
    void load(token);
  }

  if (phase !== 'ready') {
    const denied = phase === 'denied';
    return (
      <main style={{ maxWidth: 840, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Espace client (Phase 5)</h1>
        {denied ? (
          <p style={{ color: 'var(--danger)' }}>Connexion requise.</p>
        ) : (
          <p className="muted">Chargement…</p>
        )}
        <p>
          <Link href="/auth">← Retour à l&apos;authentification</Link>
        </p>
      </main>
    );
  }

  const activeSubs = subs.filter((s) => s.status === 'ACTIVE');

  return (
    <main style={{ maxWidth: 840, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Espace client (Phase 5)</h1>
      <p className="muted">
        Connecté en tant que {me?.email} ({me?.role}) ·{' '}
        <Link href="/auth">Déconnexion</Link>
      </p>

      {message && <p style={{ color: 'var(--ok, #1a7f37)' }}>{message}</p>}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <section>
        <h2>Catalogue produits</h2>
        {products.length === 0 ? (
          <p className="muted">Aucun produit disponible.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {products
              .filter((p) => p.status === 'ACTIVE' || p.status === 'SUSPENDED')
              .map((p) => (
                <li
                  key={p.id}
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
                    {p.name}{' '}
                    <span className="muted">
                      ({p.kind}
                      {p.status !== 'ACTIVE' ? `, ${p.status}` : ''})
                    </span>
                  </span>
                  <button type="button" onClick={() => subscribe(p.id)}>
                    Souscrire
                  </button>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Mes souscriptions</h2>
        {subs.length === 0 ? (
          <p className="muted">Aucune souscription. Demande l&apos;une des offres ci-dessus.</p>
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
                  <span className="muted">[{SUB_STATUS_LABEL[s.status] ?? s.status}]</span>
                </span>
                {['PENDING', 'ACTIVE', 'SUSPENDED'].includes(s.status) && (
                  <button type="button" onClick={() => cancelSub(s.id)}>
                    Annuler
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Demander un service (souscription active)</h2>
        {activeSubs.length === 0 ? (
          <p className="muted">
            Aucune souscription active. Une fois une souscription approuvée par l&apos;admin,
            tu pourras demander un service ici.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {activeSubs.map((s) => (
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
                  <strong>{s.product?.name ?? s.productId}</strong>
                </span>
                <input
                  placeholder="Nom du service"
                  value={serviceName[s.id] ?? ''}
                  onChange={(e) => setServiceName({ ...serviceName, [s.id]: e.target.value })}
                  style={{ padding: '6px 8px', boxSizing: 'border-box', width: 220 }}
                />
                <button
                  type="button"
                  disabled={!(serviceName[s.id] ?? '').trim()}
                  onClick={() => requestService(s.id)}
                >
                  Demander
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Mes services</h2>
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
                    · {svc.subscription?.product?.name ?? ''}
                  </span>
                </span>
                <span className="muted">[{SERVICE_STATUS_LABEL[svc.status] ?? svc.status}]</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          L&apos;hébergement (serveur) est géré par l&apos;administrateur : aucune donnée
          d&apos;infrastructure ne t&apos;est exposée.
        </p>
      </section>
    </main>
  );
}
