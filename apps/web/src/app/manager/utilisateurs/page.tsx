'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  apiError,
  fetchMe,
  getAccessToken,
  listUsers,
  Me,
  updateUser,
  UserAdmin,
} from '../../../lib/api';

type Phase = 'loading' | 'denied' | 'ready';
type BusyId = string | null;

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '8px 0',
  borderBottom: '1px solid var(--border, #e2e2e2)',
  flexWrap: 'wrap',
};

export default function ManagerUsersPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [users, setUsers] = useState<UserAdmin[]>([]);
  const [busy, setBusy] = useState<BusyId>(null);
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
      void load(t);
    })();
  }, [router]);

  async function load(t: string) {
    const r = await listUsers(t);
    if (!r.ok) return setError('Impossible de charger les utilisateurs.');
    setUsers((r.data as UserAdmin[]) ?? []);
  }

  async function apply(id: string, patch: { role?: string; isActive?: boolean }) {
    setBusy(id);
    setMessage(null);
    setError(null);
    const r = await updateUser(token, id, patch);
    setBusy(null);
    if (!r.ok) return setError(apiError(r, 'Échec de la mise à jour.'));
    setMessage('Utilisateur mis à jour.');
    void load(token);
  }

  if (phase === 'loading') {
    return (
      <main style={{ maxWidth: 760, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Utilisateurs</h1>
        <p className="muted">Connexion…</p>
      </main>
    );
  }

  if (phase === 'denied') {
    return (
      <main style={{ maxWidth: 760, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Utilisateurs</h1>
        <p style={{ color: 'var(--danger)' }}>Accès refusé : réservé aux administrateurs.</p>
        <p><a href="/auth">→ Retour à l&apos;authentification</a></p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 760, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>iCode Host Pro — Utilisateurs</h1>
      <p className="muted">
        Gestion des comptes (Phase 3) — connecté en tant que {me?.email} ·{' '}
        <Link href="/manager">← Tableau de bord</Link>
      </p>

      {message && <p style={{ color: 'var(--ok, #1a7f37)' }}>{message}</p>}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {users.map((u) => (
          <li key={u.id} style={rowStyle}>
            <span style={{ minWidth: 220 }}>
              {u.email}
              <div className="muted">
                {u.name ?? '—'} · {u.role} · {u.isActive ? 'actif' : 'désactivé'}
                {u.id === me?.id && <span> · (vous)</span>}
              </div>
            </span>
            <button
              disabled={busy === u.id}
              onClick={() => apply(u.id, { role: u.role === 'ADMIN' ? 'USER' : 'ADMIN' })}
            >
              {u.role === 'ADMIN' ? 'Rétrograder' : 'Promouvoir'}
            </button>
            <button disabled={busy === u.id} onClick={() => apply(u.id, { isActive: !u.isActive })}>
              {u.isActive ? 'Désactiver' : 'Activer'}
            </button>
          </li>
        ))}
      </ul>
      {users.length === 0 && <p className="muted">Aucun compte.</p>}
    </main>
  );
}