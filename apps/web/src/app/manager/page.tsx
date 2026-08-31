'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  apiError,
  apiJson,
  fetchMe,
  getAccessToken,
  getManagerSummary,
  ManagerSummary,
  Me,
} from '../../lib/api';

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

type Phase = 'loading' | 'denied' | 'ready';

const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'DISABLED'];
const SERVER_STATUSES = ['UNKNOWN', 'PROVISIONING', 'ACTIVE', 'PROBLEM', 'REMOVED'];

const inputStyle: React.CSSProperties = { padding: '6px 8px', boxSizing: 'border-box' };
const selectStyle: React.CSSProperties = { ...inputStyle, width: 150 };
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 0',
  borderBottom: '1px solid var(--border, #e2e2e2)',
  flexWrap: 'wrap',
};

export default function ManagerPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [summary, setSummary] = useState<ManagerSummary | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [drafts, setDrafts] = useState({ productName: '', serverName: '', serverHostname: '' });
  const [hostnameEdits, setHostnameEdits] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      void loadAll(t);
    })();
  }, [router]);

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
      <main style={{ maxWidth: 820, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>iCode Host Pro — Manager</h1>
        <p className="muted">Connexion…</p>
      </main>
    );
  }

  if (phase === 'denied') {
    return (
      <main style={{ maxWidth: 820, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>iCode Host Pro — Manager</h1>
        <p style={{ color: 'var(--danger)' }}>Accès refusé : réservé aux administrateurs de la plateforme.</p>
        <p>
          <a href="/auth">→ Retour à l&apos;authentification</a>
        </p>
      </main>
    );
  }

  const productsByStatus = summary?.products.byStatus ?? {};
  const serversByStatus = summary?.servers.byStatus ?? {};

  return (
    <main style={{ maxWidth: 820, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>iCode Host Pro — Manager</h1>
      <p className="muted">
        Console d&apos;administration (Phase 3) — connecté en tant que {me?.email} ·{' '}
        <Link href="/manager/utilisateurs">Utilisateurs →</Link> ·{' '}
        <Link href="/manager/journal">Journal d&apos;audit →</Link> ·{' '}
        <Link href="/manager/invitations">Invitations →</Link> ·{' '}
        <Link href="/manager/mail">Configuration mail →</Link> ·{' '}
        <Link href="/manager/subscriptions">Souscriptions &amp; services →</Link>
      </p>

      {message && <p style={{ color: 'var(--ok, #1a7f37)' }}>{message}</p>}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <section>
        <h2>Tableau de bord</h2>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div className="card">
            <strong>{summary?.products.total ?? '—'}</strong> produits
            <div className="muted">ACTIVE {productsByStatus.ACTIVE ?? 0}</div>
          </div>
          <div className="card">
            <strong>{summary?.servers.total ?? '—'}</strong> serveurs
            <div className="muted">ACTIVE {serversByStatus.ACTIVE ?? 0}</div>
          </div>
          <div className="card">
            <strong>{summary?.users.active ?? '—'}</strong> utilisateurs actifs
            <div className="muted">/{summary?.users.total ?? '—'} comptes</div>
          </div>
        </div>
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Serveurs (infrastructure)</h2>
        <form onSubmit={createServer} style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label>Nom
            <input value={drafts.serverName} onChange={(e) => setDrafts({ ...drafts, serverName: e.target.value })} required style={inputStyle} />
          </label>
          <label>Hostname
            <input value={drafts.serverHostname} onChange={(e) => setDrafts({ ...drafts, serverHostname: e.target.value })} required style={inputStyle} />
          </label>
          <button type="submit">Ajouter</button>
        </form>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {servers.map((s) => (
            <li key={s.id} style={rowStyle}>
              <span>
                {s.name}{' '}
                <input
                  value={hostnameEdits[s.id] ?? s.hostname}
                  onChange={(e) => setHostnameEdits({ ...hostnameEdits, [s.id]: e.target.value })}
                  style={{ ...inputStyle, width: 180 }}
                  aria-label="hostname"
                />
                <button onClick={() => saveServerHostname(s.id, hostnameEdits[s.id] ?? s.hostname)}>✓</button>
              </span>
              <select
                value={s.status}
                onChange={(e) => changeServerStatus(s.id, e.target.value)}
                style={selectStyle}
              >
                {SERVER_STATUSES.map((st) => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
              <button onClick={() => deleteServer(s.id)}>✕</button>
            </li>
          ))}
        </ul>
        {servers.length === 0 && <p className="muted">Aucun serveur enregistré.</p>}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Produits (catalogue)</h2>
        <form onSubmit={createProduct} style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label>Nom du produit
            <input value={drafts.productName} onChange={(e) => setDrafts({ ...drafts, productName: e.target.value })} required style={inputStyle} />
          </label>
          <button type="submit">Ajouter</button>
        </form>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {products.map((p) => (
            <li key={p.id} style={rowStyle}>
              <span>{p.name} <span className="muted">({p.kind})</span></span>
              <select
                value={p.status}
                onChange={(e) => changeProductStatus(p.id, e.target.value)}
                style={selectStyle}
              >
                {PRODUCT_STATUSES.map((st) => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
              <button onClick={() => deleteProduct(p.id)}>✕</button>
            </li>
          ))}
        </ul>
        {products.length === 0 && <p className="muted">Aucun produit enregistré.</p>}
      </section>
    </main>
  );
}