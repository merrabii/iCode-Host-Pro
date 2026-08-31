'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  apiError,
  createInvitation,
  fetchMe,
  getAccessToken,
  inviteLink,
  Invitation,
  listInvitations,
  Me,
  revokeInvitation,
} from '../../../lib/api';

type Phase = 'loading' | 'denied' | 'ready';

const STATUS_LABEL: Record<string, string> = {
  pending: 'En attente',
  used: 'Utilisée',
  revoked: 'Révoquée',
  expired: 'Expirée',
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--ok, #1a7f37)',
  used: 'var(--muted, #666)',
  revoked: 'var(--danger)',
  expired: 'var(--danger)',
};

export default function ManagerInvitationsPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [email, setEmail] = useState('');
  const [created, setCreated] = useState<{
    email: string;
    token: string;
    link: string;
    emailSent: boolean;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(t: string) {
    setError(null);
    const r = await listInvitations(t);
    if (!r.ok) {
      setError(apiError(r, 'Impossible de charger les invitations.'));
      return;
    }
    setInvites((r.data as Invitation[]) ?? []);
  }

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    const r = await createInvitation(token, email.trim());
    if (!r.ok) {
      setError(apiError(r, 'Échec de la création de l’invitation.'));
      return;
    }
    const inv = r.data as { email: string; token: string; emailSent?: boolean };
    const emailSent = !!inv.emailSent;
    setEmail('');
    setCreated({ email: inv.email, token: inv.token, link: inviteLink(inv.token, inv.email), emailSent });
    setMessage(
      emailSent
        ? `Invitation créée — l’email d’invitation a été envoyé à ${inv.email}. Le lien reste copiable en secours.`
        : 'Invitation créée. Configuration mail absente ou envoi échoué : lien affiché manuellement.',
    );
    void load(token);
  }

  async function revoke(id: string) {
    setError(null);
    const r = await revokeInvitation(token, id);
    if (!r.ok) {
      setError(apiError(r, 'Échec de la révocation.'));
      return;
    }
    setMessage('Invitation révoquée.');
    void load(token);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage('Lien copié dans le presse-papiers.');
      setError(null);
    } catch {
      setMessage(null);
      setError('Impossible de copier automatiquement — sélectionne le texte.');
    }
  }

  if (phase !== 'ready') {
    const denied = phase === 'denied';
    return (
      <main style={{ maxWidth: 720, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Invitations (Phase 5)</h1>
        {denied ? (
          <p style={{ color: 'var(--danger)' }}>Accès refusé : réservé aux administrateurs.</p>
        ) : (
          <p className="muted">Connexion…</p>
        )}
        <p>
          <Link href={denied ? '/auth' : '/manager'}>← Retour</Link>
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 720, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Invitations (Phase 5)</h1>
      <p className="muted">
        ADR-020 — l&apos;inscription libre est fermée. Envoie un lien d&apos;invitation à une
        nouvelle adresse : connecté en tant que {me?.email} ·{' '}
        <Link href="/manager">← Retour au manager</Link>
      </p>

      {message && <p style={{ color: 'var(--ok, #1a7f37)' }}>{message}</p>}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <form onSubmit={submit} style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label>
          Email à inviter
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ padding: '6px 8px', boxSizing: 'border-box', width: 260 }}
          />
        </label>
        <button type="submit">Créer l&apos;invitation</button>
      </form>

      {created && (
        <div
          className="card"
          style={{
            marginTop: 16,
            padding: 12,
            border: '1px solid var(--ok, #1a7f37)',
            wordBreak: 'break-all',
          }}
        >
          {created.emailSent ? (
            <p style={{ color: 'var(--ok, #1a7f37)', margin: '0 0 8px' }}>
              ✅ Email d&apos;invitation envoyé à {created.email}.
            </p>
          ) : (
            <p style={{ color: 'var(--danger)', margin: '0 0 8px' }}>
              ⚠️ Envoi automatique absent ou en échec — transmets ce lien manuellement
              (configure le SMTP dans « Configuration mail »).
            </p>
          )}
          <strong>
            {created.emailSent ? 'Lien de secours à transmettre à ' : 'Lien à transmettre à '}
            {created.email} :
          </strong>
          <div style={{ marginTop: 6 }}>
            <a href={created.link}>{window.location.origin + created.link}</a>
          </div>
          <div className="muted" style={{ margin: '4px 0' }}>
            Token : <code>{created.token}</code>
          </div>
          <button type="button" onClick={() => copy(window.location.origin + created.link)}>
            Copier le lien
          </button>
        </div>
      )}

      <section style={{ marginTop: '2rem' }}>
        <h2>Invitations émises</h2>
        {invites.length === 0 ? (
          <p className="muted">Aucune invitation pour l&apos;instant.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {invites.map((inv) => (
              <li
                key={inv.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 0',
                  borderBottom: '1px solid var(--border, #e2e2e2)',
                  flexWrap: 'wrap',
                }}
              >
                <span>{inv.email}</span>
                <span style={{ color: STATUS_COLOR[inv.status] }}>
                  {STATUS_LABEL[inv.status] ?? inv.status}
                </span>
                <span className="muted">
                  ⏳ {new Date(inv.expiresAt).toLocaleDateString()}
                </span>
                {inv.status === 'pending' && (
                  <button type="button" onClick={() => revoke(inv.id)}>
                    Révoquer
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
