'use client';

import { useEffect, useState } from 'react';
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
} from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { CLIENT_NAV } from '@/config/nav';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  PageIntro,
  PageLoading,
  Panel,
  statusTone,
} from '@/components/ui';
import { IconBox } from '@/components/icons';

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
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [serviceName, setServiceName] = useState<Record<string, string>>({});

  async function load(t: string) {
    try {
      const [p, s, svc] = await Promise.all([
        fetch('/api/products', { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()),
        listMySubscriptions(t),
        listMyServices(t),
      ]);
      setProducts((p as Product[]) ?? []);
      setSubs((s.data as Subscription[]) ?? []);
      setServices((svc.data as Service[]) ?? []);
    } catch {
      toast.error('Impossible de charger l’espace client.');
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

  async function subscribe(productId: string) {
    const r = await createMySubscription(token, productId);
    if (!r.ok) return toast.error(apiError(r, 'Impossible de souscrire.'));
    toast.ok('Souscription envoyée — en attente d’approbation par l’admin.');
    void load(token);
  }

  async function cancelSub(id: string) {
    const r = await cancelMySubscription(token, id);
    if (!r.ok) return toast.error(apiError(r, 'Impossible d’annuler.'));
    toast.ok('Souscription annulée.');
    void load(token);
  }

  async function requestService(subId: string) {
    const name = (serviceName[subId] ?? '').trim();
    if (!name) return;
    const r = await createMyService(token, subId, name);
    if (!r.ok) return toast.error(apiError(r, 'Impossible de demander un service.'));
    setServiceName({ ...serviceName, [subId]: '' });
    toast.ok('Service demandé.');
    void load(token);
  }

  if (phase === 'loading') {
    return (
      <AppShell me={null} nav={CLIENT_NAV}>
        <PageLoading />
      </AppShell>
    );
  }

  if (phase === 'denied') {
    return (
      <AppShell me={null} nav={CLIENT_NAV} tenant={{ label: 'Espace client' }}>
        <div className="auth-wrap">
          <div className="auth-card">
            <h2>Connexion requise</h2>
            <p>Connecte-toi pour accéder à ton espace client.</p>
            <a className="btn-primary" href="/auth">
              Se connecter
            </a>
          </div>
        </div>
      </AppShell>
    );
  }

  const activeSubs = subs.filter((s) => s.status === 'ACTIVE');

  return (
    <AppShell me={me} nav={CLIENT_NAV} tenant={{ label: 'Espace client' }}>
      <div className="wrap-md">
        <PageIntro
          eyebrow="Espace client"
          title="Mes services"
          sub="Catalogue, souscriptions et services. L’hébergement (serveur) est géré par l’administrateur : aucune donnée d’infrastructure ne t’est exposée."
        />

        <Panel title="Catalogue produits" sub={products.length > 0 ? `${products.filter((p) => p.status === 'ACTIVE' || p.status === 'SUSPENDED').length} offre(s) disponible(s)` : undefined}>
          {products.length === 0 ? (
            <EmptyState>Aucun produit disponible.</EmptyState>
          ) : (
            <div className="stack">
              {products
                .filter((p) => p.status === 'ACTIVE' || p.status === 'SUSPENDED')
                .map((p) => (
                  <div key={p.id} className="status-row">
                    <span className="status-icon">
                      <IconBox />
                    </span>
                    <div className="status-row-main">
                      <div className="status-row-title">{p.name}</div>
                      <div className="status-row-sub">
                        type {p.kind}
                        {p.status !== 'ACTIVE' ? ` · ${p.status}` : ''}
                      </div>
                    </div>
                    <Button size="sm" onClick={() => subscribe(p.id)}>Souscrire</Button>
                  </div>
                ))}
            </div>
          )}
        </Panel>

        <div className="mt">
          <Panel title="Mes souscriptions" sub="Une offre demandée reste en attente jusqu’à l’approbation par l’admin.">
            {subs.length === 0 ? (
              <EmptyState>Demande l&apos;une des offres ci-dessus.</EmptyState>
            ) : (
              <div className="stack">
                {subs.map((s) => (
                  <div key={s.id} className="status-row">
                    <div className="status-row-main">
                      <div className="status-row-title">{s.product?.name ?? s.productId}</div>
                      <div className="status-row-sub">Souscription</div>
                    </div>
                    <Badge tone={statusTone(s.status)}>{SUB_STATUS_LABEL[s.status] ?? s.status}</Badge>
                    {['PENDING', 'ACTIVE', 'SUSPENDED'].includes(s.status) && (
                      <Button size="sm" variant="secondary" onClick={() => cancelSub(s.id)}>
                        Annuler
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="mt">
          <Panel title="Demander un service" sub="Uniquement sur une souscription active.">
            {activeSubs.length === 0 ? (
              <EmptyState>
                Aucune souscription active. Une fois une souscription approuvée par l&apos;admin,
                tu pourras demander un service ici.
              </EmptyState>
            ) : (
              <div className="stack">
                {activeSubs.map((s) => (
                  <div key={s.id} className="status-row">
                    <div className="status-row-main">
                      <div className="status-row-title">{s.product?.name ?? s.productId}</div>
                      <div className="status-row-sub">Souscription active</div>
                    </div>
                    <Input
                      className="input-sm"
                      placeholder="Nom du service"
                      value={serviceName[s.id] ?? ''}
                      onChange={(e) => setServiceName({ ...serviceName, [s.id]: e.target.value })}
                    />
                    <Button
                      size="sm"
                      disabled={!(serviceName[s.id] ?? '').trim()}
                      onClick={() => requestService(s.id)}
                    >
                      Demander
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="mt">
          <Panel title="Mes services" sub="Les serveurs ne sont jamais exposés côté client.">
            {services.length === 0 ? (
              <EmptyState>Aucun service pour l&apos;instant.</EmptyState>
            ) : (
              <div className="stack">
                {services.map((svc) => (
                  <div key={svc.id} className="status-row">
                    <div className="status-row-main">
                      <div className="status-row-title">
                        {svc.name}
                        {svc.subscription?.product?.name && (
                          <span className="muted cell-sub"> · {svc.subscription.product.name}</span>
                        )}
                      </div>
                      <div className="status-row-sub">Service</div>
                    </div>
                    <Badge tone={statusTone(svc.status)}>{SERVICE_STATUS_LABEL[svc.status] ?? svc.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
