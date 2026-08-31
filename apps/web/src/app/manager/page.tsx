'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAccessToken, fetchMe, Me } from '../../lib/api';

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

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  marginTop: 4,
  boxSizing: 'border-box',
};

export default function ManagerPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [f, setF] = useState({ productName: '', serverName: '', serverHostname: '' });
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
    } catch {
      setError('Impossible de charger les données.');
    }
  }

  async function createProduct(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: f.productName, kind: 'generic' }),
    });
    if (!res.ok) return setError('Échec de la création du produit.');
    setF((x) => ({ ...x, productName: '' }));
    setMessage('Produit créé.');
    void loadAll(token);
  }

  async function deleteProduct(id: string) {
    setError(null);
    const res = await fetch(`/api/products/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return setError('Échec de la suppression du produit.');
    setMessage('Produit supprimé.');
    void loadAll(token);
  }

  async function createServer(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const res = await fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: f.serverName, hostname: f.serverHostname }),
    });
    if (!res.ok) return setError('Échec de la création du serveur.');
    setF((x) => ({ ...x, serverName: '', serverHostname: '' }));
    setMessage('Serveur créé.');
    void loadAll(token);
  }

  async function deleteServer(id: string) {
    setError(null);
    const res = await fetch(`/api/servers/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return setError('Échec de la suppression du serveur.');
    setMessage('Serveur supprimé.');
    void loadAll(token);
  }

  if (phase === 'loading') {
    return (
      <main style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>iCode Host Pro — Manager</h1>
        <p className="muted">Connexion…</p>
      </main>
    );
  }

  if (phase === 'denied') {
    return (
      <main style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>iCode Host Pro — Manager</h1>
        <p style={{ color: 'var(--danger)' }}>Accès refusé : réservé aux administrateurs de la plateforme.</p>
        <p>
          <a href="/auth">→ Retour à l&apos;authentification</a>
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 800, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>iCode Host Pro — Manager</h1>
      <p className="muted">Console d&apos;administration (Phase 2) — connecté en tant que {me?.email}.</p>

      {message && <p style={{ color: 'var(--ok, #1a7f37)' }}>{message}</p>}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <section>
        <h2>Serveurs (infrastructure)</h2>
        <form onSubmit={createServer} style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label>Nom
            <input value={f.serverName} onChange={(e) => setF({ ...f, serverName: e.target.value })} required style={inputStyle} />
          </label>
          <label>Hostname
            <input value={f.serverHostname} onChange={(e) => setF({ ...f, serverHostname: e.target.value })} required style={inputStyle} />
          </label>
          <button type="submit">Ajouter</button>
        </form>
        <ul>
          {servers.map((s) => (
            <li key={s.id}>
              {s.name} <span className="muted">({s.hostname})</span> — {s.status}
              <button onClick={() => deleteServer(s.id)} style={{ marginLeft: 8 }}>✕</button>
            </li>
          ))}
        </ul>
        {servers.length === 0 && <p className="muted">Aucun serveur enregistré.</p>}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Produits (catalogue)</h2>
        <form onSubmit={createProduct} style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label>Nom du produit
            <input value={f.productName} onChange={(e) => setF({ ...f, productName: e.target.value })} required style={inputStyle} />
          </label>
          <button type="submit">Ajouter</button>
        </form>
        <ul>
          {products.map((p) => (
            <li key={p.id}>
              {p.name} <span className="muted">({p.kind})</span> — {p.status}
              <button onClick={() => deleteProduct(p.id)} style={{ marginLeft: 8 }}>✕</button>
            </li>
          ))}
        </ul>
        {products.length === 0 && <p className="muted">Aucun produit enregistré.</p>}
      </section>
    </main>
  );
}