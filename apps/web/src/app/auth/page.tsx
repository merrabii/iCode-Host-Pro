'use client';

import { useState } from 'react';

type Mode = 'login' | 'register';

interface Profile {
  id: string;
  email: string;
  name?: string | null;
  role: string;
}

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setProfile(null);
    setToken(null);
    const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const body =
      mode === 'login' ? { email, password } : { email, password, name: name || undefined };
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(err?.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { accessToken: string };
      setToken(data.accessToken);
      setMessage(
        mode === 'login'
          ? 'Connecté. On récupère ton profil protégé…'
          : 'Compte créé. On récupère ton profil protégé…',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function fetchMe() {
    if (!token) return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/users/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setProfile((await res.json()) as Profile);
      setMessage('Accès au profil protégé OK.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function logout() {
    setError(null);
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      /* ok */
    }
    setToken(null);
    setProfile(null);
    setMessage('Déconnecté.');
  }

  return (
    <main style={{ maxWidth: 520, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>iCode Host Pro — Authentication</h1>
      <p className="muted">Phase 1 : JWT (ADR-015).</p>

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
          />
        </label>
        {mode === 'register' && (
          <label>
            Nom (optionnel)
            <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          </label>
        )}
        <label>
          Mot de passe
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
        </label>
        <button type="submit">{mode === 'login' ? 'Connexion' : 'Créer un compte'}</button>
      </form>

      <p>
        <button type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? "Pas de compte ? S'inscrire" : 'Déjà un compte ? Se connecter'}
        </button>
      </p>

      {message && <p style={{ color: 'var(--ok, #1a7f37)' }}>{message}</p>}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      {token && !profile && (
        <button type="button" onClick={fetchMe}>
          Appeler /api/users/me (protégé)
        </button>
      )}

      {profile && (
        <pre>{JSON.stringify(profile, null, 2)}</pre>
      )}

      {(token || profile) && (
        <button type="button" onClick={logout}>
          Déconnexion
        </button>
      )}
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  marginTop: 4,
  boxSizing: 'border-box',
};