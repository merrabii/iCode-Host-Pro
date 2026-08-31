'use client';

import { useEffect, useState } from 'react';
import { acceptInvite, apiError } from '@/lib/api';

type Mode = 'login' | 'invite';

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
  const [token, setToken] = useState('');
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill from an invitation link ?invite=<token>&email=<email> (§ ADR-020).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invite = params.get('invite');
    const inviteEmail = params.get('email');
    if (invite) {
      setMode('invite');
      setToken(invite);
      if (inviteEmail) setEmail(inviteEmail);
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setProfile(null);
    setAccessToken(null);

    let result: { ok: boolean; accessToken?: string; message?: string };
    if (mode === 'login') {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(err?.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { accessToken: string };
      result = { ok: true, accessToken: data.accessToken };
    } else {
      const res = await acceptInvite({ token, email, password, name: name || undefined });
      if (!res.ok) throw new Error(apiError(res, 'Jeton d’invitation invalide.'));
      const data = res.data as { accessToken: string };
      result = { ok: true, accessToken: data.accessToken };
    }

    setAccessToken(result.accessToken ?? null);
    setMessage(
      mode === 'login'
        ? 'Connecté. On récupère ton profil protégé…'
        : 'Compte créé via invitation. On récupère ton profil protégé…',
    );
  }

  async function fetchMe() {
    if (!accessToken) return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/users/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
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
    setAccessToken(null);
    setProfile(null);
    setMessage('Déconnecté.');
  }

  return (
    <main style={{ maxWidth: 520, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>iCode Host Pro — Connexion</h1>
      <p className="muted">
        Phase 5 (ADR-020) : inscription libre fermée. Un compte se crée uniquement par invitation.
      </p>

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {mode === 'invite' && (
          <label>
            Jeton d&apos;invitation (rempli depuis le lien reçu)
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              style={inputStyle}
            />
          </label>
        )}
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
        {mode === 'invite' && (
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
        <button type="submit">{mode === 'login' ? 'Connexion' : 'Créer mon compte via invitation'}</button>
      </form>

      <p>
        <button type="button" onClick={() => setMode(mode === 'login' ? 'invite' : 'login')}>
          {mode === 'login'
            ? 'J’ai une invitation — accepter un jeton'
            : 'J’ai déjà un compte — se connecter'}
        </button>
      </p>

      {message && <p style={{ color: 'var(--ok, #1a7f37)' }}>{message}</p>}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      {accessToken && !profile && (
        <button type="button" onClick={fetchMe}>
          Appeler /api/users/me (protégé)
        </button>
      )}

      {profile && <pre>{JSON.stringify(profile, null, 2)}</pre>}

      {(accessToken || profile) && (
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
