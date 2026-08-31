'use client';

import { useEffect, useState } from 'react';
import { apiError, apiJson, getManagerSummary, ManagerSummary } from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import {
  Alert,
  Button,
  Denied,
  EmptyState,
  Field,
  Input,
  PageLoading,
  Panel,
  Select,
  StatCard,
} from '@/components/ui';
import { IconBox, IconCheck, IconPlus, IconServer, IconUsers, IconX } from '@/components/icons';

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
}

const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'DISABLED'];
const SERVER_STATUSES = ['UNKNOWN', 'PROVISIONING', 'ACTIVE', 'PROBLEM', 'REMOVED'];

export default function ManagerPage() {
  const { phase, me, token } = useAdminSession();
  const [summary, setSummary] = useState<ManagerSummary | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [drafts, setDrafts] = useState({ productName: '', serverName: '', serverHostname: '' });
  const [hostnameEdits, setHostnameEdits] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setError('Impossible de charger les données.');
    }
  }

  function flash(m: string) {
    setMessage(m);
    setError(null);
  }

  async function changeProductStatus(id: string, status: string) {
    const r = await apiJson(`/api/products/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    if (!r.ok) return setError(apiError(r, 'Échec de la mise à jour du produit.'));
    flash('Statut du produit mis à jour.');
    void loadAll(token);
  }

  async function changeServerStatus(id: string, status: string) {
    const r = await apiJson(`/api/servers/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    if (!r.ok) return setError(apiError(r, 'Échec de la mise à jour du serveur.'));
    flash('Statut du serveur mis à jour.');
    void loadAll(token);
  }

  async function saveServerHostname(id: string, hostname: string) {
    if (!hostname.trim()) return;
    const r = await apiJson(`/api/servers/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ hostname: hostname.trim() }),
    });
    if (!r.ok) return setError(apiError(r, 'Échec de la mise à jour de l’hostname.'));
    flash('Hostname du serveur mis à jour.');
    void loadAll(token);
  }

  async function createProduct(e: React.FormEvent) {
    e.preventDefault();
    const r = await apiJson('/api/products', token, {
      method: 'POST',
      body: JSON.stringify({ name: drafts.productName, kind: 'generic' }),
    });
    if (!r.ok) return setError(apiError(r, 'Échec de la création du produit.'));
    setDrafts((x) => ({ ...x, productName: '' }));
    flash('Produit créé.');
    void loadAll(token);
  }

  async function deleteProduct(id: string) {
    const r = await apiJson(`/api/products/${id}`, token, { method: 'DELETE' });
    if (!r.ok) return setError(apiError(r, 'Échec de la suppression du produit.'));
    flash('Produit supprimé.');
    void loadAll(token);
  }

  async function createServer(e: React.FormEvent) {
    e.preventDefault();
    const r = await apiJson('/api/servers', token, {
      method: 'POST',
      body: JSON.stringify({ name: drafts.serverName, hostname: drafts.serverHostname }),
    });
    if (!r.ok) return setError(apiError(r, 'Échec de la création du serveur.'));
    setDrafts((x) => ({ ...x, serverName: '', serverHostname: '' }));
    flash('Serveur créé.');
    void loadAll(token);
  }

  async function deleteServer(id: string) {
    const r = await apiJson(`/api/servers/${id}`, token, { method: 'DELETE' });
    if (!r.ok) return setError(apiError(r, 'Échec de la suppression du serveur.'));
    flash('Serveur supprimé.');
    void loadAll(token);
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
          <h1>Infrastructure &amp; catalogue</h1>
          <p>
            Pilotage de la plateforme : produits, serveurs et comptes. Chaque modification est
            tracée dans le journal d&apos;audit.
          </p>
          <div className="hero-cta">
            <a className="btn btn-primary" href="#servers">
              <IconServer size={15} />
              Ajouter un serveur
            </a>
            <a className="btn btn-secondary" href="#products">
              <IconBox size={15} />
              Ajouter un produit
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

        {message && <Alert tone="ok">{message}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}

        <div className="bottom-grid">
          <Panel
            title="Serveurs (infrastructure)"
            sub="Hôtes gérés par la plateforme — statut et hostname modifiables"
          >
            <form className="inline-form mb" onSubmit={createServer}>
              <Field label="Nom">
                <Input
                  value={drafts.serverName}
                  onChange={(e) => setDrafts({ ...drafts, serverName: e.target.value })}
                  placeholder="prod-01"
                />
              </Field>
              <Field label="Hostname">
                <Input
                  value={drafts.serverHostname}
                  onChange={(e) => setDrafts({ ...drafts, serverHostname: e.target.value })}
                  placeholder="node1.exemple.com"
                />
              </Field>
              <Button type="submit">
                <IconPlus size={14} />
                Ajouter
              </Button>
            </form>

            {servers.length === 0 ? (
              <EmptyState>Aucun serveur enregistré.</EmptyState>
            ) : (
              <div className="stack">
                {servers.map((s) => (
                  <div key={s.id} className="status-row">
                    <span className={`status-icon${s.status === 'PROBLEM' ? ' amber' : s.status === 'ACTIVE' ? '' : ' info'}`}>
                      <IconServer />
                    </span>
                    <div className="status-row-main">
                      <div className="status-row-title">{s.name}</div>
                      <div className="status-row-sub mono">{s.hostname}</div>
                    </div>
                    <Input
                      className="input-sm"
                      value={hostnameEdits[s.id] ?? s.hostname}
                      onChange={(e) => setHostnameEdits({ ...hostnameEdits, [s.id]: e.target.value })}
                      aria-label="hostname"
                    />
                    <Button size="sm" variant="secondary" onClick={() => saveServerHostname(s.id, hostnameEdits[s.id] ?? s.hostname)} title="Enregistrer l'hostname">
                      <IconCheck size={14} />
                    </Button>
                    <Select
                      className="select-sm"
                      value={s.status}
                      onChange={(e) => changeServerStatus(s.id, e.target.value)}
                      aria-label="statut"
                    >
                      {SERVER_STATUSES.map((st) => (
                        <option key={st} value={st}>{st}</option>
                      ))}
                    </Select>
                    <Button size="sm" variant="danger" onClick={() => deleteServer(s.id)} title="Supprimer le serveur">
                      <IconX size={14} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title="Produits (catalogue)"
            sub="Offres de référence proposées aux clients"
          >
            <form className="inline-form mb" onSubmit={createProduct}>
              <Field label="Nom du produit">
                <Input
                  value={drafts.productName}
                  onChange={(e) => setDrafts({ ...drafts, productName: e.target.value })}
                  placeholder="Hébergement web — Starter"
                />
              </Field>
              <Button type="submit">
                <IconPlus size={14} />
                Ajouter
              </Button>
            </form>

            {products.length === 0 ? (
              <EmptyState>Aucun produit enregistré.</EmptyState>
            ) : (
              <div className="stack">
                {products.map((p) => (
                  <div key={p.id} className="status-row">
                    <span className="status-icon violet">
                      <IconBox />
                    </span>
                    <div className="status-row-main">
                      <div className="status-row-title">{p.name}</div>
                      <div className="status-row-sub">type {p.kind} · statut {p.status}</div>
                    </div>
                    <Select
                      className="select-sm"
                      value={p.status}
                      onChange={(e) => changeProductStatus(p.id, e.target.value)}
                      aria-label="statut"
                    >
                      {PRODUCT_STATUSES.map((st) => (
                        <option key={st} value={st}>{st}</option>
                      ))}
                    </Select>
                    <Button size="sm" variant="danger" onClick={() => deleteProduct(p.id)} title="Supprimer le produit">
                      <IconX size={14} />
                    </Button>
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
