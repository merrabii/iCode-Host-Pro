'use client';

import { useEffect, useState } from 'react';
import { acceptInvite, apiError } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Alert, Button, Field, Input } from '@/components/ui';

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
    <AppShell me={null} nav={[]} bare>
      <div className="wrap-sm">
        <div className="auth-card">
          <h2>{mode === 'login' ? 'Connexion' : 'Accepter l’invitation'}</h2>
          <p>
            Phase 5 (ADR-020) : inscription libre fermée — un compte se crée uniquement par
            invitation.
          </p>

          <form className="auth-form" onSubmit={submit}>
            {mode === 'invite' && (
              <Field label="Jeton d’invitation (rempli depuis le lien reçu)" required>
                <Input value={token} onChange={(e) => setToken(e.target.value)} className="input-mono" />
              </Field>
            )}
            <Field label="Email" required>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            {mode === 'invite' && (
              <Field label="Nom (optionnel)">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            )}
            <Field label="Mot de passe" required>
              <Input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button type="submit">{mode === 'login' ? 'Connexion' : 'Créer mon compte via invitation'}</Button>
          </form>

          <div className="auth-meta">
            <Button variant="secondary" onClick={() => setMode(mode === 'login' ? 'invite' : 'login')}>
              {mode === 'login'
                ? 'J’ai une invitation — accepter un jeton'
                : 'J’ai déjà un compte — se connecter'}
            </Button>
          </div>

          {message && <Alert tone="ok" title="✅">{message}</Alert>}
          {error && <Alert tone="error">{error}</Alert>}

          {accessToken && !profile && (
            <div className="mt">
              <Button variant="secondary" onClick={fetchMe}>
                Appeler /api/users/me (protégé)
              </Button>
            </div>
          )}

          {profile && (
            <pre className="mt">{JSON.stringify(profile, null, 2)}</pre>
          )}

          {(accessToken || profile) && (
            <div className="mt">
              <Button variant="danger" onClick={logout}>
                Déconnexion
              </Button>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
