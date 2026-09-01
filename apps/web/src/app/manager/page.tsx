'use client';

import { useEffect, useState } from 'react';
import { apiJson, getManagerSummary, ManagerSummary } from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import { Badge, Denied, EmptyState, PageLoading, Panel, StatCard } from '@/components/ui';
import { IconBox, IconServer, IconUsers } from '@/components/icons';

// Dashboard : VUE DE SYNTHÈSE en lecture seule. Les modifications des serveurs et
// du catalogue se font sur les pages dédiées (/manager/serveurs, /manager/produits).

interface Product {
  id: string;
  name: string;
  kind: string;
  status: string;
}

interface ServerItem {
  id: string;
  name: string;
  hostname: string;
  status: string;
  ipAddress?: string | null;
}

function serverTone(status: string): 'ok' | 'warn' | 'danger' | 'neutral' {
  switch (status) {
    case 'ACTIVE':
      return 'ok';
    case 'PROVISIONING':
      return 'warn';
    case 'PROBLEM':
      return 'danger';
    default:
      return 'neutral';
  }
}

function productTone(status: string): 'ok' | 'warn' | 'danger' | 'neutral' {
  switch (status) {
    case 'ACTIVE':
      return 'ok';
    case 'SUSPENDED':
      return 'warn';
    case 'DRAFT':
      return 'neutral';
    default:
      return 'danger';
  }
}

export default function ManagerPage() {
  const { phase, me, token } = useAdminSession();
  const toast = useToast();
  const [summary, setSummary] = useState<ManagerSummary | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [servers, setServers] = useState<ServerItem[]>([]);

  useEffect(() => {
    if (phase === 'ready' && token) void loadAll(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  async function loadAll(t: string) {
    try {
      const [p, s] = await Promise.all([
        fetch('/api/products', { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()),
        fetch('/api/servers', { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()),
      ]);
      setProducts(p as Product[]);
      setServers(s as ServerItem[]);
      const sum = await getManagerSummary(t);
      setSummary((sum.data as ManagerSummary) ?? null);
    } catch {
      toast.error('Impossible de charger les données.');
    }
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

  const productsByStatus = summary?.products.byStatus ?? {};
  const serversByStatus = summary?.servers.byStatus ?? {};

  return (
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }} info={['Système opérationnel']}>
      <div className="wrap-md">
        <div className="hero">
          <div className="hero-eyebrow">Console d&apos;administration</div>
          <h1>Vue d&apos;ensemble</h1>
          <p>
            Synthèse de la plateforme : contenus, infrastructure et comptes. Chaque
            modification est tracée dans le journal d&apos;audit.
          </p>
          <div className="hero-cta">
            <a className="btn btn-primary" href="/manager/serveurs">
              <IconServer size={15} />
              Gérer les serveurs
            </a>
            <a className="btn btn-secondary" href="/manager/produits">
              <IconBox size={15} />
              Gérer le catalogue
            </a>
          </div>
        </div>

        <div className="stats-grid">
          <StatCard
            label="Produits (catalogue)"
            value={summary?.products.total ?? '—'}
            tone="primary"
            icon={<IconBox />}
            sub={`${productsByStatus.ACTIVE ?? 0} actif(s)`}
          />
          <StatCard
            label="Serveurs (infrastructure)"
            value={summary?.servers.total ?? '—'}
            tone="info"
            icon={<IconServer />}
            sub={`${serversByStatus.ACTIVE ?? 0} actif(s)`}
          />
          <StatCard
            label="Utilisateurs actifs"
            value={summary?.users.active ?? '—'}
            tone="violet"
            icon={<IconUsers />}
            sub={`sur ${summary?.users.total ?? '—'} comptes`}
          />
        </div>

        <div className="bottom-grid">
          <Panel
            title="Serveurs (infrastructure)"
            sub="Derniers hôtes enregistrés"
            linkHref="/manager/serveurs"
            linkLabel="Gérer les serveurs →"
          >
            {servers.length === 0 ? (
              <EmptyState>Aucun serveur enregistré.</EmptyState>
            ) : (
              <div className="stack">
                {servers.slice(0, 6).map((s) => (
                  <div key={s.id} className="status-row">
                    <span
                      className={`status-icon${s.status === 'PROBLEM' ? ' amber' : s.status === 'ACTIVE' ? '' : ' info'}`}
                    >
                      <IconServer />
                    </span>
                    <div className="status-row-main">
                      <div className="status-row-title">{s.name}</div>
                      <div className="status-row-sub mono">{s.hostname}</div>
                    </div>
                    {s.ipAddress && <span className="mono muted cell-sub">{s.ipAddress}</span>}
                    <Badge tone={serverTone(s.status)}>{s.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title="Produits (catalogue)"
            sub="Offres de référence proposées aux clients"
            linkHref="/manager/produits"
            linkLabel="Gérer le catalogue →"
          >
            {products.length === 0 ? (
              <EmptyState>Aucun produit enregistré.</EmptyState>
            ) : (
              <div className="stack">
                {products.slice(0, 6).map((p) => (
                  <div key={p.id} className="status-row">
                    <span className="status-icon violet">
                      <IconBox />
                    </span>
                    <div className="status-row-main">
                      <div className="status-row-title">{p.name}</div>
                      <div className="status-row-sub">type {p.kind}</div>
                    </div>
                    <Badge tone={productTone(p.status)}>{p.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title="Lien rapide"
            sub="Accès aux principaux outils d’administration"
            className="panel-span"
          >
            <div className="quick-links">
              <a className="quick-link" href="/manager/utilisateurs">
                <IconUsers size={15} />
                Utilisateurs
              </a>
              <a className="quick-link" href="/manager/subscriptions">
                <IconBox size={15} />
                Souscriptions &amp; services
              </a>
              <a className="quick-link" href="/manager/invitations">
                <IconBox size={15} />
                Invitations
              </a>
              <a className="quick-link" href="/manager/journal">
                <IconBox size={15} />
                Journal d&apos;audit
              </a>
            </div>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
